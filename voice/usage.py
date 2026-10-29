"""Read-only, identity-bound Twilio charge evidence. Never infer null as zero."""
import asyncio, math, re, time
from decimal import Decimal, ROUND_CEILING
from costs import PUBLIC_RATES_REVIEWED_AT, PUBLIC_RATES_EXPIRE_AT, TTS_MAX_UTF8_BYTES

TERMINAL={'completed','busy','failed','no-answer','canceled'}
PRICE=re.compile(r'^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$')
SID=re.compile(r'^CA[0-9a-fA-F]{32}$')

class UsageEvidence:
    def __init__(self,config,fetch,*,clock=time.time):
        self.c=config;self.fetch=fetch;self.clock=clock;self.cache={};self.lock=asyncio.Lock()
    async def check(self,row):
        async with self.lock:
            return await self._check(row)
    async def _check(self,row):
        now=self.clock();key=(row['id'],row.get('sid'),row.get('auth_started'),row.get('usage_evidence_version'))
        cached=self.cache.get(key)
        if cached and now<cached[0]:return dict(cached[1])
        result={'schemaVersion':1,'attemptId':row['id'],'providerCallId':row.get('sid'),
                'currency':'USD','checkedAt':int(now*1000),'terminal':False,'remainingExposureMinor':None}
        ttl=60
        try:
            sid=row.get('sid')
            if not isinstance(sid,str) or not SID.fullmatch(sid):raise ValueError('Unbound call')
            body=await self.fetch(sid)
            if not isinstance(body,dict) or any(body.get(k)!=v for k,v in (
                ('sid',sid),('account_sid',self.c.account_sid),('to',self.c.owner_number),('from',self.c.from_number))):
                raise ValueError('Usage identity mismatch')
            if body.get('status') not in TERMINAL:
                result['reason']='provider_not_terminal'
            else:
                result['terminal']=True
                duration=body.get('duration')
                if not isinstance(duration,str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,7})',duration):raise ValueError('Invalid duration')
                raw=body.get('price')
                if body.get('price_unit')!='USD' or not isinstance(raw,str) or not PRICE.fullmatch(raw):raise ValueError('Charge unconfirmed')
                price=Decimal(raw)
                if not price.is_finite() or price>0:raise ValueError('Invalid charge')
                result['confirmedTwilioMinor']=int((-price*100).to_integral_value(rounding=ROUND_CEILING))
                result['durationSeconds']=int(duration)
                # Old calls lack durable evidence of the enforced speech limits.
                if row.get('usage_evidence_version')==1:
                    if duration=='0' and row.get('auth_started') is None:
                        result['remainingExposureMinor']=0
                        result['residualKind']='no_speech_possible'
                    elif PUBLIC_RATES_REVIEWED_AT<=now<PUBLIC_RATES_EXPIRE_AT:
                        cap=row.get('max_duration')
                        if isinstance(cap,int) and not isinstance(cap,bool) and 1<=cap<=180 and int(duration)<=cap:
                            minutes=math.ceil(cap/60)+1
                            usd=Decimal(minutes)*Decimal('0.0121')+Decimal(TTS_MAX_UTF8_BYTES)*Decimal('0.000030')
                            result['remainingExposureMinor']=int((usd*100).to_integral_value(rounding=ROUND_CEILING))
                            result['residualKind']='bounded_speech_and_media_exposure'
                if result['remainingExposureMinor'] is None:result['reason']='residual_exposure_unknown'
        except Exception:
            # Provider failures, malformed records and null charges remain reserved.
            result.pop('confirmedTwilioMinor',None)
            result['remainingExposureMinor']=None
            result['reason']='usage_unconfirmed';ttl=10
        if len(self.cache)>=256:self.cache.pop(next(iter(self.cache)))
        self.cache[key]=(now+ttl,dict(result))
        return result
