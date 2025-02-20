use std::{
    fs::File,
    io::{BufRead as _, BufReader},
};

use rand::{Rng as _, SeedableRng, seq::IndexedRandom as _};

const NUM_MAGNETS: i32 = 20_000_000;
const MAX_X: i32 = 500_000;
const ROTATION_RATIO: f64 = 1.0 / 50.0;
const REGULAR_ROTATION: i32 = 5;
const TWEAKED_ROTATION: i32 = 50;

fn main() {
    let f = File::open("seeds/word_list.txt").unwrap();
    let reader = BufReader::new(f);
    let words: Vec<String> = reader
        .lines()
        .map(Result::unwrap)
        .filter(|line| !line.starts_with("/"))
        .collect();

    let mut rng = rand::rngs::SmallRng::from_os_rng();
    let mut writer = csv::Writer::from_path("seeds/magnets.csv").unwrap();
    for _ in 0..NUM_MAGNETS {
        let word = words.choose(&mut rng).unwrap();
        let x = rng.random_range(-MAX_X..=MAX_X);
        let y = rng.random_range(-MAX_X..=MAX_X);

        let rotation = if rng.random_bool(ROTATION_RATIO) {
            rng.random_range(TWEAKED_ROTATION..=(360 - TWEAKED_ROTATION))
        } else {
            rng.random_range(-REGULAR_ROTATION..=REGULAR_ROTATION)
        };

        writer
            .write_record(&[
                format!("({},{})", x, y),
                rotation.to_string(),
                word.to_string(),
            ])
            .unwrap();
    }

    let f = File::open("seeds/easter_eggs.txt").unwrap();
    let reader = BufReader::new(f);
    for word in reader.lines().map(Result::unwrap) {
        let x = rng.random_range(-MAX_X..=MAX_X);
        let y = rng.random_range(-MAX_X..=MAX_X);
        let rotation = rng.random_range(-5..=5);

        writer
            .write_record(&[format!("({},{})", x, y), rotation.to_string(), word.clone()])
            .unwrap();
    }
}
