use clash_verge_i18n::t;
use std::borrow::Cow;

pub struct MenuTexts {
    pub exit: Cow<'static, str>,
}

impl MenuTexts {
    pub fn new() -> Self {
        Self { exit: t!("tray.exit") }
    }
}

pub struct MenuIds;

impl MenuIds {
    pub const EXIT: &'static str = "tray_exit";
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum TrayAction {
    SystemProxy,
    TunMode,
    MainWindow,
    TrayMenu,
    Unknown,
}

impl From<&str> for TrayAction {
    fn from(s: &str) -> Self {
        match s {
            "system_proxy" => Self::SystemProxy,
            "tun_mode" => Self::TunMode,
            "main_window" => Self::MainWindow,
            "tray_menu" => Self::TrayMenu,
            _ => Self::Unknown,
        }
    }
}
