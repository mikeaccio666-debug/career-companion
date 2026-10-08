-- Match the existing conversation_id cascade for the product owner tuple.
-- Otherwise independent user/companion cascades can hit a transient FK check.
ALTER TABLE platform_messages DROP CONSTRAINT IF EXISTS companion_message_room_owner;
ALTER TABLE platform_messages ADD CONSTRAINT companion_message_room_owner
 FOREIGN KEY(conversation_id,user_id,companion_id)
 REFERENCES platform_conversations(id,user_id,companion_id) ON DELETE CASCADE;
