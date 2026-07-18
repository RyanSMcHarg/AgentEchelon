/**
 * Cognito Pre-Authentication Lambda Trigger
 * Checks if user has been approved by admin before allowing login
 */

exports.handler = async (event) => {
  console.log('Pre-authentication trigger:', JSON.stringify(event, null, 2));

  // Get the user's custom attributes
  const approved = event.request.userAttributes['custom:approved'];

  // Check if user has been approved by admin
  if (approved !== 'true') {
    throw new Error('Your account is pending administrator approval. Please check back later.');
  }

  // User is approved, allow authentication to proceed
  return event;
};
