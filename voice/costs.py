"""Auditable pre-tax telephone/speech exposure; excludes agent models and tools."""
import asyncio, hashlib, json, math, time
from decimal import Decimal, ROUND_CEILING
import aiohttp

TTS_MAX_UTF8_BYTES=6000
# Primary sources inspected 2026-10-14; deliberately use regular Nova-3 price.
PUBLIC_RATES_REVIEWED_AT=1791944117  # Actual verification instant, UTC (not the local calendar date)
PUBLIC_RATES_EXPIRE_AT=PUBLIC_RATES_REVIEWED_AT+7*86400
RATE_SOURCES=['https://deepgram.com/pricing','https://www.twilio.com/en-us/voice/pricing/de',
 'https://help.twilio.com/articles/223132307-How-do-you-round-minutes-for-billing-']

class CostEvidence:
    def __init__(self,config,*,fetch_rates=None,clock=time.time):
        self.c=config;self.clock=clock;self.fetch_rates=fetch_rates or self._fetch
        self.rate=None;self.rate_expires=0;self.lock=asyncio.Lock()
    async def _fetch(self):
        async with aiohttp.ClientSession() as client:
            async with client.get('https://pricing.twilio.com/v2/Voice/Countries/DE',
                auth=aiohttp.BasicAuth(self.c.api_key_sid,self.c.api_key_secret),
                timeout=aiohttp.ClientTimeout(total=10),allow_redirects=False) as r:
                if r.status!=200:raise ValueError('Pricing unavailable')
                data=bytearray()
                async for chunk in r.content.iter_chunked(8192):
                    data.extend(chunk)
                    if len(data)>262144:raise ValueError('Pricing too large')
                return json.loads(data)
    async def check(self):
        now=self.clock()
        if not self.c.cost_owner_id or not self.c.cost_recipient_ref or now<PUBLIC_RATES_REVIEWED_AT or now>=PUBLIC_RATES_EXPIRE_AT:
            return {'verified':False,'reason':'cost_policy_or_public_rates_unavailable'}
        try:
            async with self.lock:
                if now>=self.rate_expires:
                    body=await self.fetch_rates()
                    if body.get('price_unit')!='USD':raise ValueError('Unexpected currency')
                    # Match destination locally; never transmit owner/origin number.
                    digits=self.c.owner_number.lstrip('+')
                    if not digits.startswith('49'):raise ValueError('Unsupported destination')
                    matches=[]
                    for p in body.get('outbound_prefix_prices',[]):
                        prefixes=p.get('destination_prefixes',[])
                        if not isinstance(prefixes,list):raise ValueError('Invalid prefixes')
                        if any(isinstance(x,str) and digits.startswith(x.lstrip('+')) for x in prefixes):
                            rate=max(Decimal(str(p['current_price'])),Decimal(str(p['base_price'])))
                            if not rate.is_finite() or rate<=0:raise ValueError('Invalid tariff')
                            matches.append(rate)
                    if not matches:raise ValueError('No matching tariff')
                    self.rate=max(matches) # conservative over every origin band
                    self.rate_expires=now+86400
            # One extra whole minute of headroom beyond ceil(duration/60).
            minutes=math.ceil(self.c.duration/60)+1
            usd=(self.rate+Decimal('0.0044')+Decimal('0.0077'))*minutes+Decimal(TTS_MAX_UTF8_BYTES)*Decimal('0.000030')
            bound=int((usd*100).to_integral_value(rounding=ROUND_CEILING))
            proof={'ownerId':self.c.cost_owner_id,'recipientRef':self.c.cost_recipient_ref,'currency':'USD',
                'maxDurationSeconds':self.c.duration,'maxExposureMinor':bound,
                'providerDurationCapVerified':True,'costScope':'telephone_speech_infrastructure','modelBudgetBound':False,
                'excludedCosts':['agent_models_and_tools','taxes','fixed_number_rental'],
                'limits':{'sttAudioSeconds':self.c.duration,'sttConnections':1,'ttsUtf8Bytes':TTS_MAX_UTF8_BYTES,'reservedBillableMinutes':minutes},
                'rates':{'twilioPerMinute':str(self.rate),'mediaStreamsPerMinute':'0.0044','nova3PerMinute':'0.0077','aura2PerCharacter':'0.000030'},
                'enforcementVersion':'twilio-timelimit-and-deepgram-hard-caps-v1',
                'publicRatesReviewedAt':PUBLIC_RATES_REVIEWED_AT*1000,'sources':RATE_SOURCES}
            digest='sha256:'+hashlib.sha256(json.dumps(proof,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            return {**proof,'verified':True,'checkedAt':int(now*1000),'expiresAt':int(min(now+30,self.rate_expires,PUBLIC_RATES_EXPIRE_AT)*1000),'digest':digest}
        except Exception:
            return {'verified':False,'reason':'rate_evidence_unavailable'}
