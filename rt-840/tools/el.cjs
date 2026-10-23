const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 800, height: 600 });
  await w.loadURL('data:text/html,<button id=a>a</button><button id=b>b</button>');
  w.webContents.sendInputEvent({type:'mouseDown',x:20,y:15,button:'left',clickCount:1});
  w.webContents.sendInputEvent({type:'mouseUp',x:20,y:15,button:'left',clickCount:1});
  w.focus(); await new Promise(r=>setTimeout(r,500));
  const r = await w.webContents.executeJavaScript(`(()=>{const b=document.getElementById('b');b.focus();const plain=b.matches(':focus-visible');b.blur();b.focus({focusVisible:true});return {chrome:'${process.versions.chrome}',plain,opt:b.matches(':focus-visible')}})()`);
  console.log('RESULT '+JSON.stringify(r)); app.quit();
});
