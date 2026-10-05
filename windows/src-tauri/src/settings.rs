// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "secondary" = the first other display
    /// (the main one when there is only one), "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Mochi's wardrobe: an outfit id (none, partyHat, ...) or "auto" for the seasons.
    /// An unknown value is treated as "auto" by the island.
    #[serde(default = "default_outfit")]
    pub outfit: String,
}

fn default_outfit() -> String {
    "auto".to_string()
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_n8n".into(),
                "integration_vercel".into(),
            ],
            screen: "secondary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            outfit: default_outfit(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_without_outfit_load_as_auto() {
        let json = r#"{"soundEnabled":true,"soundVolume":0.1,"autoCloseInterval":15.0,
            "absenceInterval":180.0,"activeIntegrations":[],"screen":"primary",
            "autostart":false,"hooksInstalled":false}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.outfit, "auto");
        assert_eq!(s.model, default_model());
    }
}
