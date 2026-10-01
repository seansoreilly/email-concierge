# Manual deployment mode: no GitHub connection. The GitHub PATs available in the
# operator's local credential store predate this repo and aren't scoped to it
# (verified: a request to the repo with the fine-grained token returned 401), and a
# broad personal token shouldn't be wired into a Terraform variable for a repo
# connection per this project's own security posture. GitHub-connected CI/CD is a
# clean fast-follow once a repo-scoped fine-grained PAT is created - see README.
#
# Deployment instead goes through scripts/deploy-web.sh: build the SPA locally,
# zip web/dist's contents, `aws amplify create-deployment` + upload + `start-deployment`.
# aws_amplify_app with no `repository` argument works fine as a deploy target for this.
#
# LEARN: Terraform here only creates the EMPTY hosting container. The site
# content is uploaded out-of-band by the script, so Terraform neither knows nor
# cares what is deployed - changing infra never redeploys the SPA.
resource "aws_amplify_app" "web" {
  name     = "${local.name_prefix}-web"
  platform = "WEB"

  # SPA rewrite: serve index.html for any path without a file extension, so
  # client-side routing (or a full-page reload on a non-root path) doesn't 404.
  custom_rule {
    source = "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>"
    target = "/index.html"
    status = "200"
  }
}

# LEARN: Amplify serves each branch at https://<branch>.<default_domain>.
# Both parts are attributes only known after creation (default_domain is
# assigned by AWS), which cognito.tf consumes for the callback URLs.
resource "aws_amplify_branch" "mvp" {
  app_id      = aws_amplify_app.web.id
  branch_name = "mvp"
  stage       = "PRODUCTION"
}
