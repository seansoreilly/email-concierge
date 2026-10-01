import {
  AdminGetUserCommand,
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({});
const allowedEmail = process.env.ALLOWED_EMAIL;

export async function handler(event) {
  if (event.triggerSource !== "PreSignUp_ExternalProvider") {
    return event;
  }

  const email = event.request.userAttributes.email;
  if (!email || email.toLowerCase() !== allowedEmail.toLowerCase()) {
    throw new Error("This app is restricted to a single Google account.");
  }

  // event.userName is "Google_<sub>" for a federated sign-in - the
  // part after the first "_" is Google's subject id.
  const underscoreIndex = event.userName.indexOf("_");
  const providerName = event.userName.slice(0, underscoreIndex);
  const providerSubject = event.userName.slice(underscoreIndex + 1);

  const destinationUser = await client.send(
    new AdminGetUserCommand({
      UserPoolId: event.userPoolId,
      Username: allowedEmail,
    }),
  );

  await client.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: event.userPoolId,
      DestinationUser: {
        ProviderName: "Cognito",
        ProviderAttributeValue: destinationUser.Username,
      },
      SourceUser: {
        ProviderName: providerName,
        ProviderAttributeName: "Cognito_Subject",
        ProviderAttributeValue: providerSubject,
      },
    }),
  );

  // Auto-confirm: this is a link to an already-verified native user,
  // not a new signup that needs its own confirmation step.
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;

  return event;
}
