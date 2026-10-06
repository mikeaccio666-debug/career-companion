import { mountLabFrame } from '../spike/mount-frame';
const hostButton = document.getElementById('host-button'), result = document.getElementById('host-result');
hostButton?.addEventListener('click', () => { if (result) result.textContent = '宿主页按钮已点击'; });
// Add ?web=1 for the ordinary-web proof; unpacked-extension proof injects its own frame.
if (new URLSearchParams(location.search).get('web') === '1') mountLabFrame('http://localhost:8871/frame.html', document.body);
