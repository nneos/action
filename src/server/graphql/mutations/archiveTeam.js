import {GraphQLID, GraphQLNonNull} from 'graphql';
import getRethink from 'server/database/rethinkDriver';
import UpdateTeamPayload from 'server/graphql/types/UpdateTeamPayload';
import {auth0ManagementClient} from 'server/utils/auth0Helpers';
import {getUserId, requireTeamLead} from 'server/utils/authorization';
import getPubSub from 'server/utils/getPubSub';
import sendSegmentEvent from 'server/utils/sendSegmentEvent';
import tmsSignToken from 'server/utils/tmsSignToken';
import shortid from 'shortid';
import {NEW_AUTH_TOKEN, NOTIFICATIONS_ADDED, TEAM_ARCHIVED, TEAM, UPDATED} from 'universal/utils/constants';
import toTeamMemberId from 'universal/utils/relay/toTeamMemberId';

const publishAuthTokensWithoutTeam = (userDocs) => {
  userDocs.forEach((user) => {
    const {id, tms} = user;
    // update the tms on auth0 in async
    auth0ManagementClient.users.updateAppMetadata({id}, {tms});
    // update the server socket, if they're logged in
    getPubSub().publish(`${NEW_AUTH_TOKEN}.${id}`, {newAuthToken: tmsSignToken({sub: id}, tms)});
  });
};

const publishTeamArchivedNotifications = (notifications, subOptions) => {
  notifications.forEach((notification) => {
    const userId = notification.userIds[0];
    const notificationsAdded = {notifications: [notification]};
    getPubSub().publish(`${NOTIFICATIONS_ADDED}.${userId}`, {notificationsAdded, ...subOptions});
  });
};

export default {
  type: UpdateTeamPayload,
  args: {
    teamId: {
      type: new GraphQLNonNull(GraphQLID),
      description: 'The teamId to archive (or delete, if team is unused)'
    }
  },
  async resolve(source, {teamId}, {authToken, dataLoader, socketId: mutatorId}) {
    const r = getRethink();
    const now = new Date();
    const operationId = dataLoader.share();

    // AUTH
    const userId = getUserId(authToken);
    const teamMemberId = toTeamMemberId(teamId, userId);
    await requireTeamLead(teamMemberId);

    // RESOLUTION
    sendSegmentEvent('Archive Team', userId, {teamId});
    const {teamResults: {notificationData, teamResult}, userDocs} = await r.table('Team')
      .get(teamId)
      .pluck('name', 'orgId')
      .do((team) => ({
        projectCount: r.table('Project').getAll(teamId, {index: 'teamId'}).count(),
        team,
        userIds: r.table('TeamMember')
          .getAll(teamId, {index: 'teamId'})
          .filter({isNotRemoved: true})('userId')
          .coerceTo('array')
      }))
      .do((doc) => ({
        userDocs: r.table('User')
          .getAll(r.args(doc('userIds')), {index: 'id'})
          .update((user) => ({tms: user('tms').difference([teamId])}), {returnChanges: true})('changes')('new_val')
          .pluck('id', 'tms')
          .default([]),
        teamName: doc('team')('name'),
        teamResults: r.branch(
          r.and(doc('projectCount').eq(0), doc('userIds').count().eq(1)),
          {
            // Team has no projects nor addn'l TeamMembers, hard delete it:
            teamResult: r.table('Team').get(teamId)
              .delete({returnChanges: true})('changes')(0)('old_val').default(null),
            teamMemberResult: r.table('TeamMember').getAll(teamId, {index: 'teamId'}).delete()
          },
          {
            notificationData: doc,
            teamResult: r.table('Team').get(teamId)
              .update({isArchived: true}, {returnChanges: true})('changes')(0)('new_val')
              .default(null)
          }
        )
      }));

    if (notificationData) {
      const {team: {name: teamName, orgId}, userIds} = notificationData;
      const notifications = userIds.map((notifiedUserId) => ({
        id: shortid.generate(),
        orgId,
        startAt: now,
        type: TEAM_ARCHIVED,
        userIds: [notifiedUserId],
        teamName
      }));
      await r.table('Notification').insert(notifications);
      publishTeamArchivedNotifications(notifications);
    }

    if (!teamResult) {
      throw new Error('Team was already archived');
    }

    // the client doesn't care whether we hard deleted or archived. just tell them we archived so it removes from list
    const team = {
      ...teamResult,
      isArchived: true
    };
    const teamUpdated = {team};
    getPubSub().publish(`${TEAM}.${teamId}`, {data: {teamId, type: UPDATED}, operationId, mutatorId});
    publishAuthTokensWithoutTeam(userDocs);
    return teamUpdated;
  }
};
