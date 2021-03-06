import {GraphQLID, GraphQLNonNull, GraphQLObjectType} from 'graphql'
import {resolveTeam} from 'server/graphql/resolvers'
import Notification, {notificationInterfaceFields} from 'server/graphql/types/Notification'
import Team from 'server/graphql/types/Team'
import TeamNotification from 'server/graphql/types/TeamNotification'
import TeamInvitation from './TeamInvitation'

const NotificationTeamInvitation = new GraphQLObjectType({
  name: 'NotificationTeamInvitation',
  description: 'A notification sent to a user that was invited to a new team',
  interfaces: () => [Notification, TeamNotification],
  fields: () => ({
    teamId: {
      description: 'FK',
      type: new GraphQLNonNull(GraphQLID)
    },
    invitationId: {
      description: 'FK',
      type: new GraphQLNonNull(GraphQLID)
    },
    invitation: {
      description: 'The invitation that triggered this notification',
      type: new GraphQLNonNull(TeamInvitation),
      resolve: async ({invitationId}, _args, {dataLoader}) => {
        return dataLoader.get('teamInvitations').load(invitationId)
      }
    },
    team: {
      type: new GraphQLNonNull(Team),
      resolve: resolveTeam
    },
    ...notificationInterfaceFields
  })
})

export default NotificationTeamInvitation
