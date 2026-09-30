import {describe,expect,it} from 'vitest';
import {parseCrisisNoticeName,suggestCrisisNoticeName,type CrisisGroup} from './crises';

const group=(status: string,ordinal=2,sessionOrdinal=1,draft=false)=>({sessionOrdinal,ordinal,nextUpdateOrdinal:3,endedAt:status==='ENDED' ? 'ended' : null,
  updates:[{status,ordinal:2},...(draft ? [{status:'UNPUBLISHED',ordinal:3}] : [])]} as CrisisGroup);

describe('crisis notice identity and suggestions',()=> {
  it('parses only complete system names and rejects invalid or overflowing numbers',()=> {
    expect(parseCrisisNoticeName(' 危机通告 1.2.3 — 港口封锁 ')).toEqual({sessionOrdinal:1,groupOrdinal:2,updateOrdinal:3});
    expect(parseCrisisNoticeName('Crisis Notice 12.10.1')).toEqual({sessionOrdinal:12,groupOrdinal:10,updateOrdinal:1});
    for(const name of ['upload-1.2.3.pdf','危机通告 1.','危机通告 1.2.3.pdf','危机通告 0.1.1','危机通告 1.2.0','危机通告 2147483648.1.1']) expect(parseCrisisNoticeName(name)).toBeNull();
  });
  it('counts only pending groups and retains the original session of one active group',()=> {
    expect(suggestCrisisNoticeName([group('UNPUBLISHED'),group('ENDED')],3,4,'zh-CN')).toBe('危机通告 3.4.1');
    expect(suggestCrisisNoticeName([group('PENDING')],3,4,'zh-CN')).toBe('危机通告 1.2.3');
    expect(suggestCrisisNoticeName([group('PENDING',2,1,true)],3,4,'en')).toBe('Crisis Notice 1.2.3');
    expect(suggestCrisisNoticeName([group('PENDING'),group('PENDING',1,3)],3,4,'zh-CN')).toBe('危机通告 3.');
  });
});
