// A real WASI program (Rust std on wasm32-wasip1) that exercises the WASI framework from the inside. Rebuild:
//   rustc --target wasm32-wasip1 -O -C strip=symbols probe.rs -o probe.wasm
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("hello") => {
            println!("hello from wasi");
            eprintln!("to stderr");
            println!("args={}", args[2..].join(","));
            println!("env={}", std::env::var("PROBE").unwrap_or_default());
            std::process::exit(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0));
        }
        Some("stdin") => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).unwrap();
            println!("{} bytes: {}", s.len(), s.to_uppercase().trim());
        }
        Some("fs") => files(),
        Some("time") => {
            let t = Instant::now();
            std::thread::sleep(Duration::from_millis(60));
            let slept = t.elapsed().as_millis();
            let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
            println!("slept>=60:{} wall>2020:{}", slept >= 60, wall > 1_577_836_800);
        }
        Some("rand") => {
            let mut m = HashMap::new();
            m.insert(1, 2);
            println!("random ok {}", m[&1]);
        }
        Some("panic") => panic!("boom"),
        Some("escape") => {
            for p in ["../outside.txt", "/etc/passwd", "a/../../outside.txt"] {
                match fs::File::open(p) {
                    Ok(_) => println!("{p}: opened"),
                    Err(e) => println!("{p}: {:?}", e.kind()),
                }
            }
        }
        _ => {
            eprintln!("usage");
            std::process::exit(2);
        }
    }
}

fn files() {
    fs::create_dir("work").unwrap();
    fs::create_dir_all("work/deep/er").unwrap();
    fs::write("work/a.txt", "hello").unwrap();
    {
        let mut f = fs::OpenOptions::new().append(true).open("work/a.txt").unwrap();
        f.write_all(b" world").unwrap();
    }
    println!("read={}", fs::read_to_string("work/a.txt").unwrap());
    {
        let mut f = fs::OpenOptions::new().read(true).write(true).open("work/a.txt").unwrap();
        f.seek(SeekFrom::Start(6)).unwrap();
        f.write_all(b"WORLD").unwrap();
        f.seek(SeekFrom::Start(0)).unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        println!("seek={s}");
        println!("tell={}", f.stream_position().unwrap());
    }
    let md = fs::metadata("work/a.txt").unwrap();
    println!("len={} file={} dir={}", md.len(), md.is_file(), fs::metadata("work").unwrap().is_dir());
    fs::write("work/b.txt", "").unwrap();
    let mut names: Vec<String> = fs::read_dir("work").unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    println!("list={}", names.join(","));
    fs::rename("work/b.txt", "work/c.txt").unwrap();
    println!("renamed={}", fs::metadata("work/c.txt").is_ok() && fs::metadata("work/b.txt").is_err());
    fs::remove_file("work/c.txt").unwrap();
    match fs::read("work/missing.txt") {
        Err(e) => println!("missing={:?}", e.kind()),
        Ok(_) => println!("missing=found"),
    }
    match fs::create_dir("work") {
        Err(e) => println!("exists={:?}", e.kind()),
        Ok(_) => println!("exists=created"),
    }
    match fs::remove_dir("work") {
        Err(e) => println!("notempty={:?}", e.raw_os_error()), // wasi std has no kind for ENOTEMPTY (errno 55)
        Ok(_) => println!("notempty=removed"),
    }
    let big = vec![7u8; 300_000];
    fs::write("work/big.bin", &big).unwrap();
    println!("big={}", fs::read("work/big.bin").unwrap().iter().filter(|b| **b == 7).count());
    fs::remove_dir_all("work").unwrap();
    println!("gone={}", fs::metadata("work").is_err());
}
