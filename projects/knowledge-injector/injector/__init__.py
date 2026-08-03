"""知识图谱注入器核心模块。

用法:
    from injector.client import LightRAGClient
    from injector import textify as txt
    from injector.worker import GraphInjector

设计原则:
    - textify: 纯函数，无状态，无 IO
    - client: 唯一的外部 IO 点, fail-silent
    - worker: 每个 inject_xxx 独立 try/except
"""