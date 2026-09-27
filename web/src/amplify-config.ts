import { Amplify } from "aws-amplify";
import { env } from "./env";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: env.cognitoUserPoolId,
      userPoolClientId: env.cognitoClientId,
      loginWith: {
        oauth: {
          domain: env.cognitoOauthDomain,
          scopes: ["openid", "email", "profile"],
          redirectSignIn: [`${window.location.origin}/`],
          redirectSignOut: [`${window.location.origin}/`],
          responseType: "code",
          providers: ["Google"],
        },
      },
    },
  },
});
