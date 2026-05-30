' start-hidden.vbs — launches stremio-rpc with no console window.
' Resolves the repo root from this script's own location (scripts\..) so the
' shortcut works regardless of the current working directory.

Dim fso, shell, scriptDir, repoRoot
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)

shell.CurrentDirectory = repoRoot

' 0 = hidden window, False = do not wait for the process to exit.
shell.Run "node src\index.js", 0, False
