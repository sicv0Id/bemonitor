' Abre o painel do Behance Monitor.
' Se o painel ja estiver ligado, so abre o navegador; se nao, liga o servidor (sem janela preta) e ele abre o navegador.
Option Explicit
Dim fso, sh, dir, url, http, ligado
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:4747"

ligado = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1000, 1000, 1000, 1000
http.open "GET", url & "/api/status", False
http.send
If Err.Number = 0 Then
  If http.status = 200 Then ligado = True
End If
On Error GoTo 0

If ligado Then
  sh.Run url
Else
  sh.CurrentDirectory = dir
  sh.Run "node """ & dir & "\server.js""", 0, False
End If
