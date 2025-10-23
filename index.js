const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.deleteUser = functions.https.onCall(async (data, context) => {
  const { uid } = data;
  if (!uid) return { error: 'User ID required' };

  try {
    // Delete from Authentication
    await admin.auth().deleteUser(uid);
    
    // Delete from Firestore
    const batch = admin.firestore().batch();
    batch.delete(admin.firestore().doc(`users/${uid}`));
    batch.delete(admin.firestore().doc(`presence/${uid}`));
    await batch.commit();
    
    return { success: true };
  } catch (err) {
    console.error('Delete failed:', err);
    return { error: 'Failed to delete user' };
  }
});