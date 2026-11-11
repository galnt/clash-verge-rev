//! Some config file template

/// template for new a profile item
pub const ITEM_LOCAL: &str = "# Profile Template for Clash Verge

proxies: []

proxy-groups: []

rules: []
";

/// enhanced profile
pub const ITEM_MERGE: &str = "# Profile Enhancement Merge Template for Clash Verge

profile:
  store-selected: true
";

pub const ITEM_MERGE_EMPTY: &str = "# Profile Enhancement Merge Template for Clash Verge

";

/// 全局扩展脚本的默认内容，和前端「重置为默认」共用同一份文件
pub const ITEM_SCRIPT: &str = include_str!("../../../src/assets/default-global-script.js.tmpl");

/// enhanced profile
pub const ITEM_RULES: &str = "# Profile Enhancement Rules Template for Clash Verge

prepend: []

append: []

delete: []
";

/// enhanced profile
pub const ITEM_PROXIES: &str = "# Profile Enhancement Proxies Template for Clash Verge

prepend: []

append: []

delete: []
";

/// enhanced profile
pub const ITEM_GROUPS: &str = "# Profile Enhancement Groups Template for Clash Verge

prepend: []

append: []

delete: []
";
