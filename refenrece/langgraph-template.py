import os
import asyncio
from dotenv import load_dotenv
from typing import TypedDict, Annotated
from langgraph.graph import StateGraph, START, END, add_messages
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

class AgentState(TypedDict):
    messages: Annotated[list, add_messages]


class DemoAgent:
    def __init__(self):
        self.llm = ChatOpenAI(api_key=..., model=..., temperature=...)
    

    async def create_agent(self):
        # === 
        # node functions
        # ===
        def init_params(state: AgentState):

            return state
        

        # === 
        # route functions
        # ===


        # === 
        # build graph
        # ===
        graph = StateGraph(AgentState)
        # add nodes
        graph.add_node("init_params", init_params)
        # add edges
        graph.add_edge(START, "init_params")
        graph.add_edge("init_params", END)
        # compile
        agent = graph.compile(checkpointer=MemorySaver())
    
        return agent

 
# ----- example
async def main():
    aiagent_instance = DemoAgent()
    agent = await aiagent_instance.create_agent()

    config = ...
    payload = {...}

    final_state = await agent.ainvoke(payload, config=config)
    print(final_state)


if __name__ == "__main__":
    asyncio.run(main())