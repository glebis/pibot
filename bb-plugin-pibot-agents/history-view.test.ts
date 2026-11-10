import {describe,it,expect} from 'vitest';
import {mergeHistory} from './history-view';
const m=(id:string)=>({id,role:'agent',text:id});
describe('saved-history reconciliation',()=>{
 it('retains loaded earlier pages for overlapping appends without duplicates',()=>{const result=mergeHistory(['a','b','c'].map(m),['b','c','d'].map(m),true,'c');expect(result.retainEarlier).toBe(true);expect(result.messages.map(x=>x.id)).toEqual(['a','b','c','d']);});
 it('drops old session/branch messages even with a shared ancestor',()=>{for(const same of [true,false]){const result=mergeHistory(['a','b','c'].map(m),['a','other'].map(m),same,'c');expect(result.retainEarlier).toBe(false);expect(result.messages.map(x=>x.id)).toEqual(['a','other']);}});
 it('resets when a disconnected latest page has no overlap and keeps unchanged arrays stable',()=>{const current=['a','b'].map(m);expect(mergeHistory(current,['x','y'].map(m),true,'b').retainEarlier).toBe(false);expect(mergeHistory(current,['a','b'].map(m),true,'b').messages).toBe(current);});
});
