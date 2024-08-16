FROM python:3.8-slim-buster

WORKDIR /
COPY signoff-check .
RUN pip install PyGithub && chmod +x /signoff-check

# require envs: OWNER,REPO_NAME,GITHUB_TOKEN,PULL_NUMBER
ENTRYPOINT ["/signoff-check"]
