import Dispatch
import WidgetKit

@_cdecl("xipu_widget_is_supported")
public func xipuWidgetIsSupported() -> Int32 {
    if #available(macOS 14.0, *) { return 1 }
    return 0
}

@_cdecl("xipu_widget_reload")
public func xipuWidgetReload() -> Int32 {
    guard #available(macOS 14.0, *) else { return 0 }
    DispatchQueue.main.async {
        WidgetCenter.shared.reloadTimelines(ofKind: "XIPUDeadlines")
    }
    return 1
}
