export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Rect = Point & Size;
