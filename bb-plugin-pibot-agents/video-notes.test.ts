import {describe,it,expect} from 'vitest';
import {videoNoteParts} from './video-notes';
const wrapper=(file:string)=>`[Video note attachment: ${JSON.stringify(file)}. Original video retained privately; save, forward to an editing agent, or edit only when requested. Do not echo its private path unless explicitly asked.]`;
describe('saved video note wrappers',()=>{
 it('preserves captions and indexes multiple videos without displaying the instruction wrapper',()=>{const parts=videoNoteParts('**Before**\n\n'+wrapper('/synthetic/first.mp4')+'\n\nAfter\n'+wrapper('/synthetic/second.mp4'));expect(parts).toEqual([{kind:'text',text:'**Before**\n\n'},{kind:'video',filePath:'/synthetic/first.mp4',index:0},{kind:'text',text:'\n\nAfter\n'},{kind:'video',filePath:'/synthetic/second.mp4',index:1}]);});
 it('keeps unrelated attachment prose and parses JSON escaped filenames',()=>{const plain='A video note attachment: here, with no PiBot wrapper.';expect(videoNoteParts(plain)).toEqual([{kind:'text',text:plain}]);expect(videoNoteParts(wrapper('/synthetic/a"b.mp4'))).toEqual([{kind:'video',filePath:'/synthetic/a"b.mp4',index:0}]);});
});
