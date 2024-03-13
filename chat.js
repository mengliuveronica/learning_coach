// 1. Import dependencies and read environment variables
const aircode = require('aircode');
const axios = require('axios');
const openai = require('openai');
const OpenAISecret = process.env.OpenAISecret; // OpenAI Secret from env
const feishuAppId = process.env.feishuAppId; // Feishu App ID from env
const feishuAppSecret = process.env.feishuAppSecret; 
const N = 20; //how many records to include in the history

// 2. Constant configurations
const frequency = 800; // Frequency for updating Feishu card messages
const enable_stream = true; // Flag for streaming output
const contentsTable = aircode.db.table('contents');


// 获取飞书 tenant_access_token 的方法
const getTenantToken = async () => {
  const url =
    'https://open.feishu.cn/open-apis/v3/auth/tenant_access_token/internal/';
  const res = await axios.post(url, {
    app_id: feishuAppId,
    app_secret: feishuAppSecret,
  });
  return res.data.tenant_access_token;
};

// 用飞书机器人回复用户消息的方法
const feishuReply = async (objs) => {
  const tenantToken = await getTenantToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${objs.msgId}/reply`;
  let content = objs.content;

  // 实现 at 用户能力
  if (objs.openId) content = `<at user_id="${objs.openId}"></at> ${content}`;
  const res = await axios({
    url,
    method: 'post',
    headers: { Authorization: `Bearer ${tenantToken}` },
    data: { msg_type: 'text', content: JSON.stringify({ text: content }) },
  });
  return res.data.data;
};
  
// 用飞书机器人回复用户card消息的方法
const feishuCardReply = async (objs) => {
  const tenantToken = await getTenantToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${objs.msgId}/reply`;
  let content = objs.content;
  const res = await axios({
    url,
    method: 'post',
    headers: { Authorization: `Bearer ${tenantToken}` },
    data: { msg_type: 'interactive', content: getCardContent(content, objs) },
  });
  res.data.data.tenantToken = tenantToken;
  console.log('新生成tenantToken', tenantToken);
  return res.data.data;
};

// 用飞书机器人回复用户消息的方法 - 更新卡片消息
const feishuUpdateCardReply = async (objs) => {
  let tenantToken = objs.tenantToken;
  if (tenantToken == null || tenantToken.length == 0) {
    tenantToken = await getTenantToken();
    console.log('新生成');
  } else {
    console.log('不用新生成');
  }
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${objs.msgId}`;
  let content = objs.content;
  const res = await axios({
    url,
    method: 'patch',
    headers: { Authorization: `Bearer ${tenantToken}` },
    data: { msg_type: 'interactive', content: getCardContent(content, objs) },
  });
  res.data.tenantToken = tenantToken;
  return res.data.data;
};

// 构造飞书card消息内容
const getCardContent = (content, objs) => {
  if (objs.openId) atstr = `<at id="${objs.openId}"></at> `;
  let data = {
    elements: [
     // { tag: 'div', text: { tag: 'lark_md', content: atstr } }, comment out the @ content inside the message
      { tag: 'div', text: { tag: 'plain_text', content } },
    ],
  };
  let json = JSON.stringify(data);
  // console.log(json);
  return json;
};

async function* chunksToLines(chunksAsync) {
  let previous = '';
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
    let eolIndex;
    while ((eolIndex = previous.indexOf('\n')) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === 'data: [DONE]') break;
      if (line.startsWith('data: ')) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

async function* linesToMessages(linesAsync) {
  for await (const line of linesAsync) {
    const message = line.substring('data :'.length);
    yield message;
  }
}

async function* streamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

// 用飞书机器人回复用户消息的方法 - 更新卡片消息
const feishuGetUserInfo = async (objs, tenantToken) => {
  if (tenantToken == null) return;
  const url = `https://open.feishu.cn/open-apis/contact/v3/users/${objs.open_id}?department_id_type=department_id&user_id_type=open_id`;
  let res = await axios({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${tenantToken}` },
  });
  return res.data.data;
};

// Create conversation id to track conversations
const getMostRecentConversationId = async (user_id) => {
  const mostRecentRecord = await contentsTable
    .where({ 'user_id': user_id }) // Filter by user_id
    .sort({ createdAt: -1 }) // Order by creation time, descending
    .limit(1) // Only fetch the most recent record
    .findOne(); // Retrieve the single record

  // Check if a record was found and return the conversation_id, or null if not found
  return mostRecentRecord ? mostRecentRecord.conversation_id : null;
}

// Handle conversation ID
const handleConversationId = async (user_id, content) => {
  let conversationId = null;

  if (content.toLowerCase() === 'hi' || content.toLowerCase() === 'hello') {
    // Generate a new conversation_id with user_id and current time
    conversationId = `${user_id}_${Date.now()}`;
  } else {
    // Attempt to retrieve the most recent conversation_id for this user
    conversationId = await getMostRecentConversationId(user_id);

    // If no previous conversation_id exists, generate a new one
    if (!conversationId) {
      conversationId = `${user_id}_${Date.now()}`;
    }
  }

  return conversationId;
};

// GPT related  
const getConversationHistory = async (user_id, N, conversationID) => {
  const records = await contentsTable
    .where({ 'user_id': user_id })// Filter by user_id
    .and({'conversation_id':conversationID})
    .sort({ createdAt: -1 }) // Order by creation time, descending, so the most recent comes first
    .limit(N) // Limit to the last N interactions to manage performance and relevance
    .find();

  // Initialize an empty array to hold the conversation history
  let conversationHistory = [];

  // Since records are fetched most recent first, iterate in reverse to build the history in chronological order
  records.forEach(msg => {
    // Check and add the assistant's reply to the history (ensure that replies that exist are processed)
    if (msg.ai_reply) {
      conversationHistory.push({ role: 'assistant', content: msg.ai_reply });
    }
    // Check and add the user's utterance to the history
    if (msg.user_utterance) {
      conversationHistory.push({ role: 'user', content: msg.user_utterance });
    }
  });

  // Finally, reverse the array to ensure the conversation history goes from oldest to newest
  return conversationHistory.reverse();
}

let chatGPT = null;

if (OpenAISecret) {
  // 与 ChatGTP 聊天的方法，传入字符串即可
  const configuration = new openai.Configuration({ apiKey: OpenAISecret });
  const client = new openai.OpenAIApi(configuration);
  if (enable_stream) {
    //https://github.com/openai/openai-node/issues/18#issuecomment-1369996933
    chatGPT = async (content,conversationHistory) => {
      console.log(conversationHistory);
      
      let transcript = conversationHistory.map(entry => {
        if (entry.role === 'user') {
          return `user: ${entry.content}`;
        } else if (entry.role === 'assistant') {
          return `assistant: ${entry.content}`;
        }
      }).join('\n');

      console.log(transcript);

      return await client.createChatCompletion(
        {
          model: 'gpt-3.5-turbo',
          // prompt: content,
          messages: conversationHistory,
          max_tokens: 3000,
          temperature: 0.1,
          stream: true,
        },
        { responseType: 'stream' }
      );
    };
  } else {
    chatGPT = async (content) => {
      return await client.createChatCompletion({
        // 使用当前 OpenAI 开放的最新 3.5 模型，如果后续 4 发布，则修改此处参数即可
        model: 'gpt-3.5-turbo',
        // 让 ChatGPT 充当的角色为 assistant
        messages: [{ role: 'assistant', content }],
      });
    };
  }
}

// 飞书 ChatGPT 机器人的入口函数
module.exports = async function (params, context) {
  // 判断是否开启了事件 Encrypt Key，如果开启提示错误
  if (params.encrypt)
    return { error: '请在飞书机器人配置中移除 Encrypt Key。' };

  // 用来做飞书接口校验，飞书接口要求有 challenge 参数时需直接返回
  if (params.challenge) return { challenge: params.challenge };

  // 判断是否没有开启事件相关权限，如果没有开启，则返回错误
  if (!params.header || !params.header.event_id) {
    // 判断当前是否为通过 Debug 环境触发
    if (context.trigger === 'DEBUG') {
      return {
        error:
          '如机器人已配置好，请先通过与机器人聊天测试，再使用「Mock by online requests」功能调试。',
      };
    } else {
      return {
        error:
          '请参考教程配置好飞书机器人的事件权限，相关权限需发布机器人后才能生效。',
      };
    }
  }

  // 所有调用当前函数的参数都可以直接从 params 中获取
  // 飞书机器人每条用户消息都会有 event_id
  const eventId = params.header.event_id;

  // 可以使用数据库极其简单地写入数据到数据表中
  // 实例化一个名字叫做 contents 的表
  const contentsTable = aircode.db.table('contents');

  // 搜索 contents 表中是否有 eventId 与当前这次一致的
  const contentObj = await contentsTable.where({ eventId }).findOne();

  // 如果 contentObj 有值，则代表这条 event 出现过
  // 由于 ChatGPT 返回时间较长，这种情况可能是飞书的重试，直接 return 掉，防止重复调用
  if (contentObj) return;
  const message = params.event.message;
  const msgType = message.message_type;

  // 获取发送消息的人信息
  const sender = params.event.sender;

  // 获取用户ID
  const user_id = sender.sender_id.user_id;

  // 用户发送过来的内容
  let content = '';

  // 返回给用户的消息
  let replyContent = '';

  // 需要更新的消息的message_id
  let replyMsgId = null;

  //ChatGPT请求结果
  let result = null;

  let tenantToken = null;


  // 目前 ChatGPT 仅支持文本内容
  if (msgType === 'text') {
    // 获取用户具体消息，机器人默认将收到的消息直接返回
    content = JSON.parse(message.content).text.replace('@_user_1 ', '');

    // Determine the appropriate conversation_id based on the user's message
    const conversationId = await handleConversationId(user_id, content);

    // 默认将用户发送的内容回复给用户，仅是一个直接返回对话的机器人
    replyContent = content;

    // 将消息体信息储存到数据库中，以备后续查询历史或做上下文支持使用
    await contentsTable.save({
      eventId,
      msgId: message.message_id,
      openId: sender.sender_id.open_id,
      user_id: user_id,
      user_utterance: content,
      conversation_id: conversationId,
    });

    const senderId = sender.sender_id.user_id; // Adjust based on real identifier
    let conversationHistory = await getConversationHistory(senderId, N,conversationId); // Decide on your desired N


    // Prepend the system message
    conversationHistory = [{ role: 'system', content: `You are an expert learning coach dedicated to help me become a more autonomous learner. Your goal is to elevate my self-awareness in learning processes and guide me in a scaffolded manner to master essential skills such as planning, motivation, self-assessment, and metacognition. Identify misconceptions and help me develop meta-cognitive thinking. 
        You always respond in one or two sentences based on the context, with the aim to help me become an autonomous learner. Politely refuse to complete writing related tasks for me (e.g., outlining, write paragraphs or essays). Be friendly and fun. Use emojis. Ask me an easy to answer follow-up question if suitable.`}, ...conversationHistory];
// Append the current user message
 //   conversationHistory.push({ role: 'user', content: `You are an expert grammar tutor focused only on discussing, teaching and practicing advanced English grammar rules, their applications, and usage tips. Your goal is to take my grammar skills in English to the next level. Encourage me to practice and use more English, offering guidance strictly on grammar-related queries. You are good at creating fun and challenging exercises for me to learn to use grammar in practice.
 //         This is my most recent utterance: ${content}. 
 //         Respond to me in one or two sentences based on the above information. Be friendly and fun. Use emojis. Ask me a follow-up question if suitable.` });
    conversationHistory.push({ role: 'user', content})
    
    console.log(conversationHistory)

    // 如果配置了 OpenAI Key 则让 ChatGPT 回复
    if (OpenAISecret) {
      // 将用户具体消息发送给 ChatGPT
      result = await chatGPT(content,conversationHistory);

      // 将获取到的 ChatGPT 回复给用户
      if (!enable_stream) {
        replyContent = `${result.data.choices[0].message.content.trim()}`;
      }
    }
  } else {
    replyContent = '不好意思，暂时不支持其他类型的文件。';
  }
  if (enable_stream) {
    replyContent = '💬Thinking...';
    if (replyMsgId == null) {
      // 将处理后的消息通过飞书机器人发送给用户
      const res = await feishuCardReply({
        msgId: message.message_id,
        openId: sender.sender_id.open_id,
        content: replyContent,
      });

      tenantToken = res.tenantToken;
      replyMsgId = res.message_id;
      const dbObj = await contentsTable.where({ eventId }).findOne();
      dbObj.replyMsgId = replyMsgId; //存储消息卡片的message_id 用于更新卡片消息
      await contentsTable.save(dbObj); //https://docs-cn.aircode.io/getting-started/database
    }
    replyContent = '';
    let t = new Date().getTime();

    for await (const message of streamCompletion(result.data)) {
      try {
        const parsed = JSON.parse(message);
        let obj = parsed.choices[0];
        // console.log( obj,'-',obj.delta.content);
        if (obj.finish_reason == 'stop') {
          console.log('结束');
          await feishuUpdateCardReply({
            msgId: replyMsgId,
            openId: sender.sender_id.open_id,
            content: replyContent,
            tenantToken,
          });
          //新增保存流式结果
          const dbObj = await contentsTable.where({ eventId }).findOne();
          dbObj.ai_reply = replyContent; //存储消息
          await contentsTable.save(dbObj);
        } else {
          let character = obj.delta.content;
          if (character != undefined) {
            replyContent += character;
          }
          let curr = new Date().getTime();
          if (curr - t > frequency) {
            t = curr;
            if (replyMsgId != null) {
              await feishuUpdateCardReply({
                msgId: replyMsgId,
                openId: sender.sender_id.open_id,
                content: replyContent,
                tenantToken,
              });
            }
          }
        }
      } catch (error) {
        console.error('Could not JSON parse stream message', message, error);
      }
    }
  } else {
    await feishuReply({
      msgId: message.message_id,
      openId: sender.sender_id.open_id,
      content: replyContent,
    });
  }

  // 整个函数调用结束，需要有返回
  return null;
};
