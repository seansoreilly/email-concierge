import { Amplify } from "aws-amplify";
import { env } from "./env";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: env.cognitoUserPoolId,
      userPoolClientId: env.cognitoClientId,
    },
  },
});
