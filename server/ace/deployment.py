"""Validate the local ACE-Step receipt without importing the model runtime."""
import hashlib
import json
import os
from pathlib import Path


def sha(path):
    with Path(path).open('rb') as stream:
        digest=hashlib.sha256()
        for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
        return digest.hexdigest()


def deployment(verify=False):
    filename=os.environ.get('GERM_ACE_CONFIG')
    if not filename:raise ValueError('ACE-Step has not been provisioned and evaluated locally')
    value=json.loads(Path(filename).read_text())
    if value.get('status')!='admitted' or value.get('model')!='acestep-v15-turbo' or not value.get('revision') or not value.get('files'):
        raise ValueError('ACE-Step deployment is not admitted')
    if verify and any(sha(path)!=digest for path,digest in value['files'].items()):
        raise ValueError('ACE-Step artifact changed after evaluation')
    return value


def music_parameters(value):
    from pydantic import BaseModel, ConfigDict, Field
    from typing import Literal
    class Music(BaseModel):
        model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
        bpm: float | None=Field(default=None,ge=30,le=300)
        key: str=Field(default='',max_length=20)
        meter: Literal['','2','3','4','6']=''
        lyrics: str=Field(default='',max_length=4096)
        language: str=Field(default='unknown',pattern=r'^(unknown|[a-z]{2})$')
    return Music.model_validate(value).model_dump(exclude_none=True)
