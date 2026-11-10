const glyphs:Record<string,{name:string;paths:string[]}>= {
 heartbeat:{name:'Heartbeat',paths:['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z']},
 cascade:{name:'Cascade',paths:['M6 3v12a6 6 0 0 0 12 0V9','M3 3h6','M15 9h6','M3 21h6']},
 'cascade-recover':{name:'Cascade recovery',paths:['M3 10a9 9 0 1 1 2.6 8.4','M3 4v6h6']},
 scheduler:{name:'Scheduled task',paths:['M12 8v4l3 2','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0']},
 goal:{name:'Goal',paths:['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0','M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0','M12 12h.01']},
 'compaction-resume':{name:'Context resumed',paths:['M9 3H5a2 2 0 0 0-2 2v4','M15 3h4a2 2 0 0 1 2 2v4','M21 15v4a2 2 0 0 1-2 2h-4','M9 21H5a2 2 0 0 1-2-2v-4','M8 12h8','m13 9 3 3-3 3']},
 'silent-turn':{name:'Silent turn',paths:['m11 5-6 4H2v6h3l6 4V5Z','m17 9 5 6','m22 9-5 6']},
 handoff:{name:'Handoff',paths:['M3 7h18','m17 3 4 4-4 4','M21 17H3','m7 13-4 4 4 4']},
};

export function MessageMarker({kind,label}:{kind:string;label:string}){
 const glyph=glyphs[kind]??glyphs.cascade;
 return <span className="pb-message-marker pb-service-icon" data-kind={kind} role="img" aria-label={glyph.name} title={label}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyph.paths.map((d,i)=><path key={i} d={d}/>)}</svg></span>;
}
