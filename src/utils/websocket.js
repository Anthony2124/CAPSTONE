let wssInstance = null;

function setWss(wss) {
  wssInstance = wss;
}

function broadcast(event, data) {
  if (!wssInstance) return;
  const payload = JSON.stringify({ event, data });
  wssInstance.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

module.exports = { setWss, broadcast };
