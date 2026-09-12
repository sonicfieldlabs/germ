from typing import Literal
from pydantic import BaseModel,ConfigDict,Field

class Controls(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    profile:Literal['general','noncommercial_research']='general'
    start_seconds:float=Field(default=0,ge=0,le=86400)
    latent_scale:float=Field(default=1,ge=0,le=2)
    latent_bias:float=Field(default=0,ge=-1,le=1)

class ResearchRequest(Controls):
    tool:Literal['rave-guitar','basic-pitch']
    key:str=Field(pattern=r'^[a-f0-9]{64}$')
    seconds:float=Field(default=10,gt=0,le=30)
    seed:int=Field(default=0,ge=0,le=4294967294)
