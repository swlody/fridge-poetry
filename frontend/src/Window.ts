import { pack } from "msgpackr";
import { Buffer } from "node:buffer";

// Window that represents the total area of magnets in the DOM
// This is a 3x3 grid of [viewport area] centered at the actual viewport
export class Window {
  x1: number;
  y1: number;
  x2: number;
  y2: number;

  constructor(x1: number, y1: number, x2: number, y2: number) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
  }

  contains(x: number, y: number): boolean {
    return x >= this.x1 && x <= this.x2 && y >= this.y1 && y <= this.y2;
  }

  pack(): Buffer {
    return pack([this.x1, this.y1, this.x2, this.y2]);
  }

  chooseRandomEdgeCoords(): [number, number] {
    let x = 0;
    let y = 0;
    const rand = Math.random();
    if (rand < 0.25) {
      x = this.x1;
      y = Math.floor(Math.random() * (this.y2 - this.y1 + 1)) + this.y2;
    } else if (rand < 0.5) {
      x = this.x2;
      y = Math.floor(Math.random() * (this.y2 - this.y1 + 1)) + this.y2;
    } else if (rand < 0.75) {
      y = this.y1;
      x = Math.floor(Math.random() * (this.x2 - this.x1 + 1)) + this.x2;
    } else {
      y = this.y2;
      x = Math.floor(Math.random() * (this.x2 - this.x1 + 1)) + this.x2;
    }

    return [x, y];
  }
}
