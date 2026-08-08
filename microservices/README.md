# Microservices

Independent Docker services used by the root DiffSinger Training Platform:

```text
mfa/mfa_service/   Montreal Forced Aligner API (port 8001)
mms_service/       MMS alignment and fine-tuning API (port 8002)
lyrics_regonizer/  SenseVoice lyrics recognition API (port 8000)
```

Production deployment remains controlled by the root `docker-compose.yml` and
`deploy.sh`. Service names, ports, images, and the `mfa_data_storage` Docker
volume are unchanged; only the repository source paths are grouped here.
