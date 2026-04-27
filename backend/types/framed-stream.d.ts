declare module "framed-stream" {
  import { Duplex } from "streamx";
  export = class FramedStream extends Duplex {
    constructor(duplexStream: NodeJS.ReadWriteStream);
    write(data: Buffer): void;
    end(): void;
    on(event: "data", callback: (data: Buffer) => void): void;
    on(event: "close", callback: () => void): void;
    on(event: "error", callback: (error: unknown) => void): void;
    on(event: "end", callback: () => void): void;
    on(event: "finish", callback: () => void): void;
    off(event: "data", callback: (data: Buffer) => void): void;
    off(event: "close", callback: () => void): void;
    off(event: "error", callback: (error: unknown) => void): void;
    off(event: "end", callback: () => void): void;
    off(event: "finish", callback: () => void): void;
  };
}
