import { TaskRunner as Runner } from '../src/core/runner.js';
// Existing UI fixtures provide one exact draft; explicitly accept it in the new
// independent writing-choice phase. Candidate-selection behavior has its own tests.
export class TaskRunner extends Runner {
  constructor(...args: ConstructorParameters<typeof Runner>) {
    const decider = args[0];
    super({...decider, decide: async (...request) => request[2].proposal_0
      ? {choice:'proposal_0',confidence:1,probability:1,latencyMs:0}
      : decider.decide(...request)}, args[1], args[2]);
  }
}
