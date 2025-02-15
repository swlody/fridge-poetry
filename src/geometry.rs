use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug)]
pub struct Polygon {
    pub p1: Point,
    pub p2: Point,
    pub p3: Point,
    pub p4: Point,
    pub p5: Point,
    pub p6: Point,
}

#[derive(Debug)]
pub enum Shape {
    Window(Window),
    Polygon(Polygon),
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Window {
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
}

impl Window {
    #[tracing::instrument]
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x1 && x <= self.x2 && y >= self.y1 && y <= self.y2
    }

    #[tracing::instrument]
    pub fn difference(&self, other: &Window) -> Option<Shape> {
        if self.x1 == other.x1 && self.x2 == other.x2 && self.y1 == other.y1 && self.y2 == other.y2
        {
            return None;
        }

        if self.x2 <= other.x1 || self.x1 >= other.x2 || self.y2 <= other.y1 || self.y1 >= other.y2
        {
            return Some(Shape::Window(other.clone()));
        }

        if other.x1 <= self.x1 && other.x2 >= self.x2 && other.y1 <= self.y1 && other.y2 >= self.y2
        {
            return Some(Shape::Window(other.clone()));
        }

        if self.x1 <= other.x1 && self.x2 >= other.x2 && self.y1 <= other.y1 && self.y2 >= other.y2
        {
            return Some(Shape::Window(other.clone()));
        }

        if self.x1 == other.x1 && self.x2 == other.x2 {
            return Some(Shape::Window(Window {
                x1: other.x1,
                x2: other.x2,
                y1: self.y2.min(other.y1),
                y2: self.y2.max(other.y2),
            }));
        }
        if self.y1 == other.y1 && self.y2 == other.y2 {
            return Some(Shape::Window(Window {
                x1: self.x2.min(other.x1),
                x2: self.x2.max(other.x2),
                y1: other.y1,
                y2: other.y2,
            }));
        }

        Some(Shape::Polygon(Polygon {
            p1: Point {
                x: other.x1,
                y: other.y1,
            },
            p2: Point {
                x: other.x2,
                y: other.y1,
            },
            p3: Point {
                x: other.x2,
                y: self.y2,
            },
            p4: Point {
                x: self.x2,
                y: self.y2,
            },
            p5: Point {
                x: self.x2,
                y: other.y2,
            },
            p6: Point {
                x: other.x1,
                y: other.y2,
            },
        }))
    }
}
