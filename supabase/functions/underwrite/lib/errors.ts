// A failure tied to a specific engine step. `userMessage` is what the caller
// sees; `message` (technical) goes to logs. The pipeline maps `step` onto the
// job's error_step.
export class StepError extends Error {
  readonly step: number;
  readonly userMessage: string;
  constructor(step: number, userMessage: string, technical?: string) {
    super(technical ?? userMessage);
    this.name = "StepError";
    this.step = step;
    this.userMessage = userMessage;
  }
}
