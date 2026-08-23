-- 光鸭闪推自动安装脚本 v2
-- 通过系统辅助功能接口操作 Chrome 扩展管理页完成"加载已解密的扩展程序"
-- 返回值：ALREADY_INSTALLED / INSTALLED_OK / 各种 ERR_* 错误码

on hunt(root, targetText)
	-- 递归查找标题/描述包含 targetText 的任意元素
	tell application "System Events"
		tell process "Google Chrome"
			try
				set els to UI elements of root
			on error
				return missing value
			end try
			repeat with el in els
				set t to ""
				try
					set t to title of el as text
				end try
				if t is "" then
					try
						set t to description of el as text
					end try
				end if
				if t is not "" and t contains targetText then
					return contents of el
				end if
				set res to my hunt(contents of el, targetText)
				if res is not missing value then return res
			end repeat
		end tell
	end tell
	return missing value
end hunt

on huntRole(root, wantRole, targetText)
	-- 递归查找角色为 wantRole 且标题/描述包含 targetText 的元素
	tell application "System Events"
		tell process "Google Chrome"
			try
				set els to UI elements of root
			on error
				return missing value
			end try
			repeat with el in els
				set r to ""
				try
					set r to role of el as text
				end try
				set t to ""
				try
					set t to title of el as text
				end try
				if t is "" then
					try
						set t to description of el as text
					end try
				end if
				if r is wantRole and t is not "" and t contains targetText then
					return contents of el
				end if
				set res to my huntRole(contents of el, wantRole, targetText)
				if res is not missing value then return res
			end repeat
		end tell
	end tell
	return missing value
end huntRole

on run
	set extPath to "/Users/chouyiyan/.zcode/workspace/default/guangya-flash-push"
	
	-- 激活 Chrome 并打开 chrome://extensions（新标签自动置前）
	tell application "Google Chrome"
		activate
		delay 0.5
		open location "chrome://extensions/"
	end tell
	delay 3
	
	tell application "System Events"
		tell process "Google Chrome"
			set frontmost to true
		end tell
	end tell
	
	tell application "System Events"
		set chromeWin to window 1 of process "Google Chrome"
	end tell
	
	-- 已安装则直接结束
	if my hunt(chromeWin, "光鸭闪推") is not missing value then
		return "ALREADY_INSTALLED"
	end if
	
	-- 开发者模式开关：只点 AXCheckBox（避免点到旁边的静态文本标签）
	set devToggle to my huntRole(chromeWin, "AXCheckBox", "开发者模式")
	if devToggle is missing value then set devToggle to my huntRole(chromeWin, "AXCheckBox", "Developer mode")
	if devToggle is missing value then return "ERR_DEV_TOGGLE_NOT_FOUND"
	
	tell application "System Events"
		set devVal to (value of devToggle) as text
	end tell
	if devVal is "0" or devVal is "false" then
		tell application "System Events" to click devToggle
		delay 2.5
		try
			tell application "System Events"
				set devVal2 to (value of devToggle) as text
			end tell
			if devVal2 is "0" or devVal2 is "false" then return "ERR_TOGGLE_STILL_OFF"
		end try
	end if
	
	-- 加载未打包的扩展程序按钮（AXButton，新版 Chrome 文案为"加载未打包的扩展程序"）
	set loadBtn to my huntRole(chromeWin, "AXButton", "加载未打包")
	if loadBtn is missing value then set loadBtn to my huntRole(chromeWin, "AXButton", "加载已解密")
	if loadBtn is missing value then set loadBtn to my huntRole(chromeWin, "AXButton", "Load unpacked")
	if loadBtn is missing value then return "ERR_LOAD_BUTTON_NOT_FOUND"
	
	tell application "System Events" to click loadBtn
	delay 2
	
	-- 原生文件选择框：Cmd+Shift+G 前往文件夹 → 输入路径 → 两次回车
	try
		tell application "System Events"
			tell process "Google Chrome"
				keystroke "g" using {command down, shift down}
				delay 1.2
				keystroke extPath
				delay 0.6
				keystroke return
				delay 1.5
				keystroke return
			end tell
		end tell
	on error errMsg
		return "ERR_AX_KEYSTROKE: " & errMsg
	end try
	delay 3
	
	-- 校验扩展卡片是否出现
	tell application "System Events"
		set chromeWin2 to window 1 of process "Google Chrome"
	end tell
	if my hunt(chromeWin2, "光鸭闪推") is not missing value then
		return "INSTALLED_OK"
	end if
	return "ERR_VERIFY_FAILED"
end run
