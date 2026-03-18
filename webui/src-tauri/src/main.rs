// Hide the extra console window on Windows release builds. Debug builds keep it
// so a failing start can still be read in a terminal.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pie_desktop_lib::run();
}
