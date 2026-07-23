import { AccountsError } from "../types.js";

/** A valid request lost its optimistic account-incarnation fence. */
export class AccountIncarnationConflictError extends AccountsError {
  constructor(message = "profile changed while login finalization was in progress") {
    super(message);
    this.name = "AccountIncarnationConflictError";
  }
}
