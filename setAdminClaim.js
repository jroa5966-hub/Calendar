const admin = require('firebase-admin');

if (!admin.apps.length) {
  // Use a service account JSON placed in this folder, or use ADC (see notes below)
  admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccountKey.json'))
  });
}

const uid = process.argv[2];
if (!uid) {
  console.error('Usage: node setAdminClaim.js <EmQe6P00OIc1bYxyvfF0767Qryw2>');
  process.exit(1);
}

admin.auth().setCustomUserClaims(uid, { admin: true })
  .then(() => {
    console.log('Admin claim set for', uid);
    process.exit(0);
  })
  .catch(err => {
    console.error('Error setting admin claim:', err);
    process.exit(1);
  });