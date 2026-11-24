// Prints the pin of a server's certificate: the SHA-256 of its public key, which is what GRAPE_PINS wants.
//   node scripts/pin.mjs grape.example.com [port]
// Build the program with it:  GRAPE_SERVER=https://grape.example.com GRAPE_PINS=<pin>[,<next pin>] cargo build --release
import tls from 'node:tls';
import crypto from 'node:crypto';

const [host, port = '443'] = process.argv.slice(2);
if (!host) { console.error('Usage: node scripts/pin.mjs <host> [port]'); process.exit(1); }
const socket = tls.connect({ host, port: Number(port), servername: host }, () => {
  const cert = new crypto.X509Certificate(socket.getPeerCertificate(true).raw);
  const pin = crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  console.log(`${host}:${port}  valid until ${cert.validTo}\nGRAPE_PINS=${pin}`);
  console.log('\nA renewed certificate keeps this pin only if it keeps the same key. Pin the key of the NEXT certificate as well (a second, comma-separated value) before renewing, or the old programs stop connecting.');
  socket.end();
});
socket.on('error', (e) => { console.error('Could not connect: ' + e.message); process.exit(1); });
