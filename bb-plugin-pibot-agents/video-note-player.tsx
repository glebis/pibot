import {useEffect,useRef,useState} from 'react';

const mediaPath='/api/v1/plugins/pibot-agents/http/video';
/** History media is served only through this plugin's opaque, same-origin route. */
function safeVideoSource(src:string|undefined):string|undefined {
 if(!src)return;
 try{
  const url=new URL(src,window.location.href);
  const keys=Array.from(url.searchParams.keys()),id=url.searchParams.get('id');
  if(url.origin!==window.location.origin||url.pathname!==mediaPath||url.username||url.password||url.hash||keys.length!==1||keys[0]!=='id'||!id||!/^[A-Za-z0-9_-]{16,128}$/.test(id))return;
  return url.pathname+url.search;
 }catch{return;}
}
export function VideoNotePlayer({src}:{src?:string}){
 const source=safeVideoSource(src),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
 const video=useRef<HTMLVideoElement>(null);
 const [playing,setPlaying]=useState(false),[muted,setMuted]=useState(false),[currentTime,setCurrentTime]=useState(0),[duration,setDuration]=useState(0),[playbackError,setPlaybackError]=useState(false);
 useEffect(()=>{setFailed(false);setAttempt(0);setPlaying(false);setMuted(false);setCurrentTime(0);setDuration(0);setPlaybackError(false)},[source]);
 const updateDuration=()=>{const value=video.current?.duration;setDuration(value&&Number.isFinite(value)?value:0)};
 const togglePlayback=async()=>{
  const element=video.current;if(!element)return;
  setPlaybackError(false);
  if(!element.paused){element.pause();return}
  try{await element.play()}catch{setPlaybackError(true)}
 };
 if(!source||failed)return <div className="pb-video-unavailable" role="status"><span>Video note unavailable.</span>{source&&<button type="button" onClick={()=>{setFailed(false);setAttempt(value=>value+1);setCurrentTime(0);setDuration(0);setPlaybackError(false)}}>Retry video</button>}</div>;
 return <div className="pb-video-player">
  <video key={`${source}:${attempt}`} ref={video} className="pb-video-note" src={source} playsInline preload="metadata" aria-label="Video note" muted={muted}
   onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onLoadedMetadata={updateDuration} onDurationChange={updateDuration}
   onTimeUpdate={()=>setCurrentTime(video.current?.currentTime||0)} onVolumeChange={()=>setMuted(video.current?.muted||false)} onError={()=>{setPlaying(false);setFailed(true)}}/>
  <div className="pb-video-controls" role="group" aria-label="Video note controls">
   <button type="button" className="pb-video-button" aria-label={playing?'Pause video note':'Play video note'} title={playing?'Pause':'Play'} onClick={()=>void togglePlayback()}>
    <svg viewBox="0 0 24 24" aria-hidden="true">{playing?<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>:<path d="m8 5 11 7-11 7z"/>}</svg>
   </button>
   <input className="pb-video-seek" type="range" aria-label="Seek video note" aria-valuetext={`${videoTime(currentTime)} of ${videoTime(duration)}`} min={0} max={duration||0} step={0.1} value={Math.min(currentTime,duration)} disabled={!duration} onChange={event=>{const element=video.current;if(element){element.currentTime=Number(event.target.value);setCurrentTime(element.currentTime)}}}/>
   <span className="pb-video-time">{videoTime(currentTime)} / {videoTime(duration)}</span>
   <button type="button" className="pb-video-button" aria-label={muted?'Unmute video note':'Mute video note'} title={muted?'Unmute':'Mute'} onClick={()=>setMuted(value=>!value)}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3z"/>{muted?<path d="m16 9 5 6m0-6-5 6" fill="none" stroke="currentColor" strokeWidth="2"/>:<path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" fill="none" stroke="currentColor" strokeWidth="2"/>}</svg>
   </button>
  </div>
  {playbackError&&<div className="pb-video-playback-error" role="status">Could not play video. Try again.</div>}
 </div>;
}
function videoTime(seconds:number){const value=Math.max(0,Math.floor(seconds));return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`}
