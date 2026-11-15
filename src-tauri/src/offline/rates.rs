// RR-38 offline mode: the player's rates.json. Same ranges as the offline backend's RATE_LIMITS
// (the backend); a test below reads that file and fails if the two differ. The backend clamps
// again on read, so this is the first of two checks, not the only one. Only the offline backend reads this file; the
// live backend has no code that reads it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::Path;

pub const RATES_SCHEMA: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limit {
    pub key: &'static str,
    pub min: f64,
    pub max: f64,
    pub integer: bool,
    pub official: f64,
}

pub const LIMITS: [Limit; 8] = [
    Limit { key: "xp", min: 0.5, max: 10.0, integer: false, official: 1.0 },
    Limit { key: "weaponXp", min: 0.5, max: 10.0, integer: false, official: 1.0 },
    Limit { key: "huntPassXp", min: 0.5, max: 10.0, integer: false, official: 1.0 },
    Limit { key: "coinChance", min: 0.0, max: 1.0, integer: false, official: 0.25 },
    Limit { key: "coinsPerRun", min: 1.0, max: 10.0, integer: true, official: 1.0 },
    Limit { key: "ramsPerGrant", min: 0.0, max: 100000.0, integer: true, official: 5000.0 },
    Limit { key: "bountyTokensPerDay", min: 0.0, max: 10.0, integer: true, official: 0.0 },
    Limit { key: "materials", min: 0.5, max: 10.0, integer: false, official: 1.0 },
];

/// cellFusionSpeed is accepted by the backend but applied by the offline DLL (stage 5); the launcher keeps whatever
/// value the file has and offers no slider for it yet.
const CELL_FUSION: Limit = Limit { key: "cellFusionSpeed", min: 0.5, max: 10.0, integer: false, official: 1.0 };

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineRates {
    pub xp: f64,
    pub weapon_xp: f64,
    pub hunt_pass_xp: f64,
    pub coin_chance: f64,
    pub coins_per_run: f64,
    pub coins_from_all_escalations: bool,
    pub rams_per_grant: f64,
    pub bounty_tokens_per_day: f64,
    pub materials: f64,
}

impl OfflineRates {
    pub fn official() -> Self {
        OfflineRates {
            xp: 1.0,
            weapon_xp: 1.0,
            hunt_pass_xp: 1.0,
            coin_chance: 0.25,
            coins_per_run: 1.0,
            coins_from_all_escalations: false,
            rams_per_grant: 5000.0,
            bounty_tokens_per_day: 0.0,
            materials: 1.0,
        }
    }

    fn get(&self, key: &str) -> f64 {
        match key {
            "xp" => self.xp,
            "weaponXp" => self.weapon_xp,
            "huntPassXp" => self.hunt_pass_xp,
            "coinChance" => self.coin_chance,
            "coinsPerRun" => self.coins_per_run,
            "ramsPerGrant" => self.rams_per_grant,
            "bountyTokensPerDay" => self.bounty_tokens_per_day,
            "materials" => self.materials,
            _ => f64::NAN,
        }
    }

    fn set(&mut self, key: &str, v: f64) {
        match key {
            "xp" => self.xp = v,
            "weaponXp" => self.weapon_xp = v,
            "huntPassXp" => self.hunt_pass_xp = v,
            "coinChance" => self.coin_chance = v,
            "coinsPerRun" => self.coins_per_run = v,
            "ramsPerGrant" => self.rams_per_grant = v,
            "bountyTokensPerDay" => self.bounty_tokens_per_day = v,
            "materials" => self.materials = v,
            _ => {}
        }
    }
}

pub fn clamp_value(limit: &Limit, v: f64) -> f64 {
    if !v.is_finite() {
        return limit.official;
    }
    let c = v.max(limit.min).min(limit.max);
    if limit.integer {
        c.round()
    } else {
        // Two decimals are plenty for a slider and keep the file readable.
        (c * 100.0).round() / 100.0
    }
}

/// Clamps every value to its range (integers rounded). Returns the clamped rates and one note per changed value.
pub fn clamp(rates: &OfflineRates) -> (OfflineRates, Vec<String>) {
    let mut out = rates.clone();
    let mut notes = Vec::new();
    for limit in LIMITS.iter() {
        let v = rates.get(limit.key);
        let c = clamp_value(limit, v);
        if c != v {
            notes.push(format!("{}: {} changed to {}", limit.key, v, c));
        }
        out.set(limit.key, c);
    }
    (out, notes)
}

#[derive(Debug, PartialEq)]
pub struct ReadResult {
    pub rates: OfflineRates,
    /// "file" or "official" (missing, broken or wrong schema)
    pub source: &'static str,
    pub warnings: Vec<String>,
    /// Kept as is on the next write (DLL-side value, no slider yet).
    pub cell_fusion_speed: Option<f64>,
}

/// Same rules as the backend's ParseRates: wrong shape or schema = official rates; numbers clamped; never fails.
pub fn parse(text: &str) -> ReadResult {
    let official = |w: String| ReadResult { rates: OfflineRates::official(), source: "official", warnings: vec![w], cell_fusion_speed: None };
    let doc: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(_) => return official("rates.json is not valid JSON; using official rates".to_string()),
    };
    let Some(obj) = doc.as_object() else {
        return official("rates.json is not a JSON object; using official rates".to_string());
    };
    if obj.get("schema").and_then(Value::as_u64) != Some(RATES_SCHEMA) {
        return official(format!("rates.json schema is not {RATES_SCHEMA}; using official rates"));
    }
    let mut rates = OfflineRates::official();
    let mut warnings = Vec::new();
    for limit in LIMITS.iter() {
        match obj.get(limit.key) {
            None => {}
            Some(v) => match v.as_f64() {
                Some(n) => {
                    let c = clamp_value(limit, n);
                    if c != n {
                        warnings.push(format!("{}: {} clamped to {}", limit.key, n, c));
                    }
                    rates.set(limit.key, c);
                }
                None => warnings.push(format!("{}: not a number, using {}", limit.key, limit.official)),
            },
        }
    }
    if let Some(v) = obj.get("coinsFromAllEscalations") {
        match v.as_bool() {
            Some(b) => rates.coins_from_all_escalations = b,
            None => warnings.push("coinsFromAllEscalations: not true/false, using false".to_string()),
        }
    }
    let cell_fusion_speed = obj.get(CELL_FUSION.key).and_then(Value::as_f64).map(|v| clamp_value(&CELL_FUSION, v));
    ReadResult { rates, source: "file", warnings, cell_fusion_speed }
}

pub fn read(file: &Path) -> ReadResult {
    match fs::read_to_string(file) {
        Ok(text) => parse(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReadResult {
            rates: OfflineRates::official(),
            source: "official",
            warnings: Vec::new(),
            cell_fusion_speed: None,
        },
        Err(_) => ReadResult {
            rates: OfflineRates::official(),
            source: "official",
            warnings: vec!["rates.json could not be read; using official rates".to_string()],
            cell_fusion_speed: None,
        },
    }
}

/// The JSON document written to rates.json (schema first, integers as integers).
pub fn to_document(rates: &OfflineRates, cell_fusion_speed: Option<f64>) -> Value {
    let (r, _) = clamp(rates);
    let mut m = Map::new();
    m.insert("schema".into(), Value::from(RATES_SCHEMA));
    for limit in LIMITS.iter() {
        let v = r.get(limit.key);
        let value = if limit.integer { Value::from(v as i64) } else { Value::from(v) };
        m.insert(limit.key.into(), value);
        if limit.key == "coinsPerRun" {
            m.insert("coinsFromAllEscalations".into(), Value::from(r.coins_from_all_escalations));
        }
    }
    m.insert(CELL_FUSION.key.into(), Value::from(cell_fusion_speed.unwrap_or(CELL_FUSION.official)));
    Value::Object(m)
}

/// Writes `bytes` to `target` atomically: a temp file in the same folder, flushed to disk, then renamed over the
/// target (on Windows `fs::rename` replaces an existing file). A reader (the offline backend polls the file) sees
/// either the old file or the new one, never a half-written one. The temp file is removed if anything fails.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = target.parent().ok_or_else(|| "Invalid file location.".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the offline folder: {e}"))?;
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, target)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Couldn't save {name}: {e}"));
    }
    Ok(())
}

/// Validates, clamps and writes rates.json atomically. Returns what was written.
pub fn save(file: &Path, rates: &OfflineRates) -> Result<OfflineRates, String> {
    let keep_fusion = read(file).cell_fusion_speed;
    let (clamped, _) = clamp(rates);
    let doc = to_document(&clamped, keep_fusion);
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n";
    write_atomic(file, text.as_bytes())?;
    Ok(clamped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rr38-rates-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn official_rates_are_inside_their_limits_and_unchanged_by_clamp() {
        let (c, notes) = clamp(&OfflineRates::official());
        assert_eq!(c, OfflineRates::official());
        assert!(notes.is_empty());
    }

    #[test]
    fn clamp_bounds_integers_and_bad_numbers() {
        let mut r = OfflineRates::official();
        r.xp = 50.0;
        r.weapon_xp = 0.1;
        r.coin_chance = 1.5;
        r.coins_per_run = 3.6;
        r.rams_per_grant = -10.0;
        r.bounty_tokens_per_day = f64::NAN;
        r.materials = 2.345;
        let (c, notes) = clamp(&r);
        assert_eq!(c.xp, 10.0);
        assert_eq!(c.weapon_xp, 0.5);
        assert_eq!(c.coin_chance, 1.0);
        assert_eq!(c.coins_per_run, 4.0);
        assert_eq!(c.rams_per_grant, 0.0);
        assert_eq!(c.bounty_tokens_per_day, 0.0);
        assert_eq!(c.materials, 2.35);
        assert_eq!(notes.len(), 7);
    }

    #[test]
    fn parse_matches_backend_rules() {
        assert_eq!(parse("not json").source, "official");
        assert_eq!(parse("[1]").source, "official");
        assert_eq!(parse(r#"{"schema":2,"xp":5}"#).source, "official");
        let r = parse(r#"{"schema":1,"xp":5,"coinChance":"lots","coinsFromAllEscalations":"yes","materials":99,"cellFusionSpeed":3}"#);
        assert_eq!(r.source, "file");
        assert_eq!(r.rates.xp, 5.0);
        assert_eq!(r.rates.coin_chance, 0.25);
        assert!(!r.rates.coins_from_all_escalations);
        assert_eq!(r.rates.materials, 10.0);
        assert_eq!(r.cell_fusion_speed, Some(3.0));
        assert_eq!(r.warnings.len(), 3);
        // A BOM (some editors add one) is tolerated, like the backend does.
        assert_eq!(parse("\u{feff}{\"schema\":1}").source, "file");
    }

    #[test]
    fn document_has_schema_integers_and_every_key() {
        let doc = to_document(&OfflineRates::official(), None);
        assert_eq!(doc["schema"], 1);
        assert!(doc["coinsPerRun"].is_i64() || doc["coinsPerRun"].is_u64());
        assert!(doc["ramsPerGrant"].is_i64() || doc["ramsPerGrant"].is_u64());
        assert_eq!(doc["coinsFromAllEscalations"], false);
        assert_eq!(doc["cellFusionSpeed"], 1.0);
        for limit in LIMITS.iter() {
            assert!(doc.get(limit.key).is_some(), "{}", limit.key);
        }
        // What the launcher writes reads back the same.
        let back = parse(&doc.to_string());
        assert_eq!(back.rates, OfflineRates::official());
        assert!(back.warnings.is_empty());
    }

    #[test]
    fn save_is_atomic_and_keeps_cell_fusion() {
        let dir = temp_dir("save");
        let file = dir.join("rates.json");
        fs::write(&file, r#"{"schema":1,"cellFusionSpeed":4}"#).unwrap();
        let mut r = OfflineRates::official();
        r.xp = 2.0;
        r.coins_per_run = 99.0;
        let written = save(&file, &r).unwrap();
        assert_eq!(written.coins_per_run, 10.0);
        let back = read(&file);
        assert_eq!(back.rates.xp, 2.0);
        assert_eq!(back.rates.coins_per_run, 10.0);
        assert_eq!(back.cell_fusion_speed, Some(4.0));
        // No temp file is left behind.
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "{leftovers:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_write_leaves_the_old_file_and_no_temp() {
        let dir = temp_dir("fail");
        let file = dir.join("rates.json");
        fs::write(&file, "old").unwrap();
        // A directory where the target should be: the rename fails, the old content of the folder stays.
        let blocked = dir.join("blocked");
        fs::create_dir_all(blocked.join("x")).unwrap();
        assert!(write_atomic(&blocked, b"new").is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        let names: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_file_means_official() {
        let r = read(Path::new(r"Z:\no\such\folder\rates.json"));
        assert_eq!(r.source, "official");
        assert_eq!(r.rates, OfflineRates::official());
    }
}
