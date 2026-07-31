import { P4FixtureError } from "./p4-jsonl-fixture.mjs";

export class LifecycleFixture {
  constructor() {
    this.threadId = null;
    this.turnId = null;
    this.responseObserved = false;
    this.rootCompleted = false;
    this.rootStatus = null;
    this.cancelAcknowledged = false;
    this.children = new Map();
    this.buffered = [];
    this.duplicates = 0;
    this.lateEvents = 0;
  }

  apply(event) {
    switch (event.type) {
      case "thread-response":
        this.threadId = event.threadId;
        break;
      case "turn-response":
        this.responseObserved = true;
        this.turnId = event.turnId;
        this.flushBuffered();
        break;
      case "child-started":
      case "child-completed":
      case "turn-completed":
        if (!this.turnId) {
          this.buffered.push(event);
        } else {
          this.applyLifecycleEvent(event);
        }
        break;
      case "interrupt-ack":
        this.cancelAcknowledged = true;
        break;
      case "transport-eof":
        this.lateEvents += 1;
        break;
      default:
        throw new P4FixtureError("P4E_LIFECYCLE_EVENT", `unknown lifecycle event ${event.type}`);
    }
    return this.snapshot();
  }

  flushBuffered() {
    const buffered = this.buffered;
    this.buffered = [];
    for (const event of buffered) {
      this.applyLifecycleEvent(event);
    }
  }

  applyLifecycleEvent(event) {
    if (event.type === "turn-completed") {
      if (event.turnId !== this.turnId) {
        this.lateEvents += 1;
        return;
      }
      if (this.rootCompleted) {
        this.duplicates += 1;
        return;
      }
      this.rootCompleted = true;
      this.rootStatus = event.status;
      return;
    }
    const current = this.children.get(event.childId);
    if (event.type === "child-started") {
      if (event.parentTurnId !== this.turnId) {
        throw new P4FixtureError("P4E_CHILD_PARENT", "child is not related to the root turn");
      }
      if (current) {
        this.duplicates += 1;
      } else {
        this.children.set(event.childId, "running");
      }
      return;
    }
    if (!current) {
      if (event.parentTurnId !== this.turnId) {
        throw new P4FixtureError("P4E_CHILD_PARENT", "child is not related to the root turn");
      }
      this.children.set(event.childId, "completed");
      return;
    }
    if (current === "completed") {
      this.duplicates += 1;
    } else {
      this.children.set(event.childId, "completed");
    }
  }

  snapshot() {
    const childrenSettled = [...this.children.values()].every(
      (status) => status === "completed"
    );
    return {
      terminal:
        this.responseObserved &&
        this.rootCompleted &&
        childrenSettled,
      responseObserved: this.responseObserved,
      rootCompleted: this.rootCompleted,
      rootStatus: this.rootStatus,
      cancelAcknowledged: this.cancelAcknowledged,
      childCount: this.children.size,
      childrenSettled,
      bufferedCount: this.buffered.length,
      duplicates: this.duplicates,
      lateEvents: this.lateEvents
    };
  }
}
