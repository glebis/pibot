// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {VideoNotePlayer} from './video-note-player';
const src='/api/v1/plugins/pibot-agents/http/video?id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it('controls playback, seeking and mute using media events',async()=>{
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
 const pause=vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 const view=render(<VideoNotePlayer src={src}/>),video=view.getByLabelText('Video note') as HTMLVideoElement;
 const seek=view.getByRole('slider',{name:'Seek video note'}) as HTMLInputElement;
 expect(seek.disabled).toBe(true);
 Object.defineProperty(video,'duration',{configurable:true,value:13});fireEvent.loadedMetadata(video);
 expect(seek.disabled).toBe(false);expect(seek.max).toBe('13');
 fireEvent.click(view.getByRole('button',{name:'Play video note'}));expect(play).toHaveBeenCalledOnce();
 Object.defineProperty(video,'paused',{configurable:true,value:false});fireEvent.play(video);
 fireEvent.click(view.getByRole('button',{name:'Pause video note'}));expect(pause).toHaveBeenCalledOnce();
 fireEvent.change(seek,{target:{value:'6'}});expect(video.currentTime).toBe(6);
 video.currentTime=8;fireEvent.timeUpdate(video);expect(seek.value).toBe('8');expect(view.getByText('0:08 / 0:13')).toBeTruthy();
 fireEvent.click(view.getByRole('button',{name:'Mute video note'}));expect(video.muted).toBe(true);
 fireEvent.click(view.getByRole('button',{name:'Unmute video note'}));expect(video.muted).toBe(false);
 fireEvent.ended(video);expect(view.getByRole('button',{name:'Play video note'})).toBeTruthy();
});
it('keeps rejected playback recoverable and resets controls when the source changes',async()=>{
 vi.spyOn(HTMLMediaElement.prototype,'play').mockRejectedValue(new Error('Playback blocked'));
 const view=render(<VideoNotePlayer src={src}/>),video=view.getByLabelText('Video note') as HTMLVideoElement;
 fireEvent.click(view.getByRole('button',{name:'Play video note'}));await waitFor(()=>expect(view.getByRole('status').textContent).toContain('Try again'));
 expect(view.getByLabelText('Video note')).toBe(video);
 Object.defineProperty(video,'duration',{configurable:true,value:13});fireEvent.loadedMetadata(video);
 fireEvent.click(view.getByRole('button',{name:'Mute video note'}));
 view.rerender(<VideoNotePlayer src={src.replace('id=aaaa','id=bbbb')}/>);
 expect(view.queryByRole('status')).toBeNull();expect(view.getByRole('button',{name:'Mute video note'})).toBeTruthy();
 expect((view.getByRole('slider',{name:'Seek video note'}) as HTMLInputElement).disabled).toBe(true);
});
