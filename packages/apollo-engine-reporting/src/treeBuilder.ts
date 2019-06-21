import { GraphQLResolveInfo, ResponsePath, responsePathAsArray } from 'graphql';
import { Trace } from 'apollo-engine-reporting-protobuf';

export class EngineReportingTreeBuilder {
  private startHrTime?: [number, number];
  private stopped = false;
  private rootNode = new Trace.Node();
  private nodes = new Map<string, Trace.Node>([
    [rootResponsePath, this.rootNode],
  ]);

  public startTiming() {
    if (this.startHrTime) {
      throw Error('startTiming called twice!');
    }
    if (this.stopped) {
      throw Error('startTiming called after stopTiming!');
    }
    this.startHrTime = process.hrtime();
  }

  public willResolveField(info: GraphQLResolveInfo): () => void {
    if (!this.startHrTime) {
      throw Error('willResolveField called before startTiming!');
    }
    if (this.stopped) {
      throw Error('willResolveField called after stopTiming!');
    }

    const path = info.path;
    const node = this.newNode(path);
    node.type = info.returnType.toString();
    node.parentType = info.parentType.toString();
    node.startTime = durationHrTimeToNanos(process.hrtime(this.startHrTime));

    return () => {
      node.endTime = durationHrTimeToNanos(process.hrtime(this.startHrTime));
    };
  }

  public addError(
    path: ReadonlyArray<string | number> | undefined,
    error: Trace.Error,
  ) {
    if (!this.startHrTime) {
      throw Error('addError called before startTiming!');
    }
    if (this.stopped) {
      throw Error('addError called after stopTiming!');
    }

    // By default, put errors on the root node.
    let node = this.rootNode;
    if (path) {
      const specificNode = this.nodes.get(path.join('.'));
      if (specificNode) {
        node = specificNode;
      }
    }

    node.error.push(error);
  }

  public stopTiming(): { durationNs: number; rootNode: Trace.Node } {
    if (!this.startHrTime) {
      throw Error('stopTiming called before startTiming!');
    }
    if (this.stopped) {
      throw Error('stopTiming called twice!');
    }

    this.stopped = true;
    return {
      durationNs: durationHrTimeToNanos(process.hrtime(this.startHrTime)),
      rootNode: this.rootNode,
    };
  }

  private newNode(path: ResponsePath): Trace.Node {
    const node = new Trace.Node();
    const id = path.key;
    if (typeof id === 'number') {
      node.index = id;
    } else {
      node.fieldName = id;
    }
    this.nodes.set(responsePathAsString(path), node);
    const parentNode = this.ensureParentNode(path);
    parentNode.child.push(node);
    return node;
  }

  private ensureParentNode(path: ResponsePath): Trace.Node {
    const parentPath = responsePathAsString(path.prev);
    const parentNode = this.nodes.get(parentPath);
    if (parentNode) {
      return parentNode;
    }
    // Because we set up the root path when creating this.nodes, we now know
    // that path.prev isn't undefined.
    return this.newNode(path.prev!);
  }
}

// Converts an hrtime array (as returned from process.hrtime) to nanoseconds.
//
// ONLY CALL THIS ON VALUES REPRESENTING DELTAS, NOT ON THE RAW RETURN VALUE
// FROM process.hrtime() WITH NO ARGUMENTS.
//
// The entire point of the hrtime data structure is that the JavaScript Number
// type can't represent all int64 values without loss of precision:
// Number.MAX_SAFE_INTEGER nanoseconds is about 104 days. Calling this function
// on a duration that represents a value less than 104 days is fine. Calling
// this function on an absolute time (which is generally roughly time since
// system boot) is not a good idea.
//
// XXX We should probably use google.protobuf.Duration on the wire instead of
// ever trying to store durations in a single number.
function durationHrTimeToNanos(hrtime: [number, number]) {
  return hrtime[0] * 1e9 + hrtime[1];
}

// Convert from the linked-list ResponsePath format to a dot-joined
// string. Includes the full path (field names and array indices).
function responsePathAsString(p: ResponsePath | undefined) {
  if (p === undefined) {
    return '';
  }
  return responsePathAsArray(p).join('.');
}

const rootResponsePath = responsePathAsString(undefined);
