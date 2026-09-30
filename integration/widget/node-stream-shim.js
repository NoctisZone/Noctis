// Node's `stream`, for the creator-fee widget's browser build.
//
// Only the `cbor` package asks for it, inside Mesh's UTxORPC provider, which
// the fee claim never constructs. `cbor` still defines its stream subclasses
// as it loads, so the module has to supply something to extend. These classes
// let it load and refuse to be built: a claim that ever reaches a Node stream
// fails with this sentence rather than misbehaving.

class Unavailable {
  constructor() {
    throw new Error('Node streams are not part of this browser bundle.');
  }
}

export class Stream extends Unavailable {}
export class Readable extends Unavailable {}
export class Writable extends Unavailable {}
export class Duplex extends Unavailable {}
export class Transform extends Unavailable {}
export class PassThrough extends Unavailable {}

export default { Stream, Readable, Writable, Duplex, Transform, PassThrough };
