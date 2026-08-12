import {describe, expect, it} from 'vitest';
import {MotionType} from '../models/motion';
import {destinationName} from './motion';

describe('motion destination names', () => {
  it('names the interface opened by each implemented motion action', () => {
    expect(destinationName(MotionType.OpenModeratedCaucus)).toBe('Caucuses');
    expect(destinationName(MotionType.ExtendModeratedCaucus)).toBe('Caucuses');
    expect(destinationName(MotionType.CloseModeratedCaucus)).toBe('Caucuses');
    expect(destinationName(MotionType.OpenUnmoderatedCaucus)).toBe('Unmod');
    expect(destinationName(MotionType.ExtendUnmoderatedCaucus)).toBe('Unmod');
    expect(destinationName(MotionType.AddWorkingPaper)).toBe('Unmod');
    expect(destinationName(MotionType.IntroduceDraftResolution)).toBe('Draft resolution');
    expect(destinationName(MotionType.IntroduceAmendment)).toBe('Amendments');
    expect(destinationName(MotionType.VoteOnResolution)).toBe('Voting');
    expect(destinationName(MotionType.ProposeStrawpoll)).toBe('Strawpolls');
  });

  it('omits the button name when the motion has no destination', () => {
    expect(destinationName(MotionType.OpenDebate)).toBeUndefined();
  });
});
