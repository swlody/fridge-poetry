use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Debug)]
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
    pub fn is_valid(&self) -> bool {
        self.x2 > self.x1 && self.y2 > self.y1
    }

    #[tracing::instrument]
    pub fn clamp(self) -> Window {
        const MAX_WIDTH: i32 = 23040;
        const MAX_HEIGHT: i32 = 12960;

        let width = self.x2 - self.x1;
        let height = self.y2 - self.y1;

        let (x1, x2) = if width > MAX_WIDTH {
            let width_diff = width - MAX_WIDTH;

            let new_x1 = self.x1 - width_diff / 2;
            let new_x2 = self.x2 + width_diff / 2;

            tracing::trace!(
                "Clamping width to valid window size: {} -> {}... ({},{}) -> ({}, {})",
                width,
                MAX_WIDTH,
                self.x1,
                self.x2,
                new_x1,
                new_x2
            );

            (self.x1 - width_diff / 2, self.x2 + width_diff / 2)
        } else {
            (self.x1, self.x2)
        };

        let (y1, y2) = if height > MAX_HEIGHT {
            let height_diff = height - MAX_HEIGHT;
            let new_y1 = self.y1 - height_diff / 2;
            let new_y2 = self.y2 + height_diff / 2;

            tracing::trace!(
                "Clamping height to valid window size: {} -> {}... ({},{}) -> ({}, {})",
                height,
                MAX_HEIGHT,
                self.y1,
                self.y2,
                new_y1,
                new_y2
            );

            (new_y1, new_y2)
        } else {
            (self.y1, self.y2)
        };

        Window { x1, x2, y1, y2 }
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

        // fuck me

        if other.x1 > self.x1 && other.y1 > self.y1 {
            Some(Shape::Polygon(Polygon {
                p1: Point {
                    x: other.x1,
                    y: other.y2,
                },
                p2: Point {
                    x: other.x2,
                    y: other.y2,
                },
                p3: Point {
                    x: other.x2,
                    y: other.y1,
                },
                p4: Point {
                    x: self.x2,
                    y: other.y1,
                },
                p5: Point {
                    x: self.x2,
                    y: self.y2,
                },
                p6: Point {
                    x: other.x1,
                    y: self.y2,
                },
            }))
        } else if other.x1 > self.x1 && other.y1 < self.y1 {
            Some(Shape::Polygon(Polygon {
                p1: Point {
                    x: other.x1,
                    y: other.y1,
                },
                p2: Point {
                    x: other.x1,
                    y: self.y1,
                },
                p3: Point {
                    x: self.x2,
                    y: self.y1,
                },
                p4: Point {
                    x: self.x2,
                    y: other.y2,
                },
                p5: Point {
                    x: other.x2,
                    y: other.y2,
                },
                p6: Point {
                    x: other.x2,
                    y: other.y1,
                },
            }))
        } else if other.x1 < self.x1 && other.y1 > self.y1 {
            Some(Shape::Polygon(Polygon {
                p1: Point {
                    x: other.x1,
                    y: other.y1,
                },
                p2: Point {
                    x: other.x1,
                    y: other.y2,
                },
                p3: Point {
                    x: other.x2,
                    y: other.y2,
                },
                p4: Point {
                    x: other.x2,
                    y: self.y2,
                },
                p5: Point {
                    x: self.x1,
                    y: self.y2,
                },
                p6: Point {
                    x: self.x1,
                    y: other.y1,
                },
            }))
        } else {
            Some(Shape::Polygon(Polygon {
                p1: Point {
                    x: other.x1,
                    y: other.y1,
                },
                p2: Point {
                    x: other.x1,
                    y: other.y2,
                },
                p3: Point {
                    x: self.x1,
                    y: other.y2,
                },
                p4: Point {
                    x: self.x1,
                    y: self.y1,
                },
                p5: Point {
                    x: other.x2,
                    y: self.y1,
                },
                p6: Point {
                    x: other.x2,
                    y: other.y1,
                },
            }))
        }
    }
}
