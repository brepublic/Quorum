import {makeDropdownOption} from "../utils";
import {DEFAULT_SPEAKER_TIME_SECONDS} from "./constants";

export enum Unit {
  Minutes = 'min',
  Seconds = 'sec'
}

export function getSeconds(duration: number, unit: Unit): number {
  return duration * (unit === Unit.Minutes ? 60 : 1);
}

export const UNIT_OPTIONS = [
  Unit.Seconds,
  Unit.Minutes
].map(makeDropdownOption);

export interface TimerData {
  elapsed: number;
  remaining: number;
  ticking: boolean | number;
}

export function advanceTimer(timer: TimerData, seconds: number): TimerData {
  const remainingBeforeTick = Math.max(0, timer.remaining);
  const elapsedNow = Math.min(remainingBeforeTick, Math.max(0, seconds));
  const remaining = remainingBeforeTick - elapsedNow;

  return {
    ...timer,
    elapsed: timer.elapsed + elapsedNow,
    remaining,
    ticking: remaining === 0 ? false : timer.ticking
  };
}

export const DEFAULT_TIMER = {
  elapsed: 0,
  remaining: DEFAULT_SPEAKER_TIME_SECONDS,
  ticking: false
};
