// core targets both Node and browsers, so it builds against plain ES libs.
// structuredClone is a web-platform API that exists in both (Node 17+, every
// current browser), but it isn't part of the ES lib; declare just that.
declare function structuredClone<T>(value: T): T;
