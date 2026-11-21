import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Spinner } from "@medusajs/icons"
import { Button, Container, Heading, StatusBadge, Table, Text, Textarea, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type LiqPayReviewList,
  type ReviewAttempt,
  formatDateTime,
  formatMoney,
  statusInfo,
} from "../../../lib/liqpay"
import { sdk } from "../../../lib/sdk"

const QUERY_KEY = ["medusa-plugin-liqpay", "reviews"]

/**
 * Settings → LiqPay: replaced checkout attempts where LiqPay shows money may have
 * moved, and refunds whose outcome is unknown. Read from the plugin's safety ledger.
 */
const LiqPayReviewPage = () => {
  const { t, i18n } = useTranslation("liqpay")
  const locale = i18n.language || "en"
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => sdk.client.fetch<LiqPayReviewList>("/admin/liqpay/reviews"),
  })

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="divide-y p-0">
        <div className="flex flex-col gap-y-1 px-6 py-4">
          <Heading level="h1">{t("review.title")}</Heading>
          <Text size="small" className="text-ui-fg-subtle">{t("review.intro")}</Text>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-x-2 px-6 py-4">
            <Spinner className="text-ui-fg-muted animate-spin" aria-hidden />
            <Text size="small" className="text-ui-fg-subtle">{t("loading")}</Text>
          </div>
        ) : isError ? (
          <Text size="small" className="text-ui-fg-error px-6 py-4">{t("loadError")}</Text>
        ) : !data?.attempts.length ? (
          <Text size="small" className="text-ui-fg-subtle px-6 py-4">{t("review.noAttempts")}</Text>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("fields.orderId")}</Table.HeaderCell>
                <Table.HeaderCell>{t("review.signed")}</Table.HeaderCell>
                <Table.HeaderCell>{t("fields.status")}</Table.HeaderCell>
                <Table.HeaderCell>{t("review.replaced")}</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.attempts.map((attempt) => (
                <AttemptRow key={attempt.session_id} attempt={attempt} locale={locale} />
              ))}
            </Table.Body>
          </Table>
        )}
      </Container>

      {data && data.refunds.length > 0 && (
        <Container className="divide-y p-0">
          <div className="flex flex-col gap-y-1 px-6 py-4">
            <Heading level="h2">{t("review.refundsTitle")}</Heading>
            <Text size="small" className="text-ui-fg-subtle">{t("review.refundsIntro")}</Text>
          </div>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("fields.orderId")}</Table.HeaderCell>
                <Table.HeaderCell>{t("review.operation")}</Table.HeaderCell>
                <Table.HeaderCell>{t("live.amount")}</Table.HeaderCell>
                <Table.HeaderCell>{t("review.state")}</Table.HeaderCell>
                <Table.HeaderCell>{t("review.started")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.refunds.map((refund) => (
                <Table.Row key={`${refund.session_id}:${refund.operation_id}`}>
                  <Table.Cell className="font-mono">{refund.session_id}</Table.Cell>
                  <Table.Cell className="font-mono">{refund.operation_id}</Table.Cell>
                  <Table.Cell>{refund.amount}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge color="orange">{t(`review.refundState.${refund.state}`)}</StatusBadge>
                  </Table.Cell>
                  <Table.Cell>{formatDateTime(refund.created_at, locale)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Container>
      )}
    </div>
  )
}

const AttemptRow = ({ attempt, locale }: { attempt: ReviewAttempt; locale: string }) => {
  const { t } = useTranslation("liqpay")
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const info = statusInfo(attempt.last_status?.status)
  const live = attempt.last_status
  const review = useMutation({
    mutationFn: () =>
      sdk.client.fetch(`/admin/liqpay/attempts/${encodeURIComponent(attempt.session_id)}/review`, {
        method: "POST",
        body: { note },
      }),
    onSuccess: async () => {
      toast.success(t("review.done"))
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t("review.failed"))
    },
  })

  return (
    <>
      <Table.Row>
        <Table.Cell className="font-mono">{attempt.session_id}</Table.Cell>
        <Table.Cell>
          {attempt.amount !== null && attempt.currency_code
            ? formatMoney(attempt.amount, attempt.currency_code, locale)
            : "—"}
        </Table.Cell>
        <Table.Cell>
          <div className="flex flex-col gap-y-1 py-2">
            <StatusBadge color={info.color}>
              {t(info.key, { defaultValue: info.raw ?? "—" })}
            </StatusBadge>
            {typeof live?.amount === "number" && live.currency && (
              <Text size="xsmall" className="text-ui-fg-subtle">
                {formatMoney(live.amount, live.currency, locale)}
              </Text>
            )}
          </div>
        </Table.Cell>
        <Table.Cell>
          {attempt.retired_at ? formatDateTime(attempt.retired_at, locale) : t("review.notReplaced")}
        </Table.Cell>
        <Table.Cell className="text-right">
          <Button size="small" variant="secondary" onClick={() => setOpen((value) => !value)}>
            {t("review.markReviewed")}
          </Button>
        </Table.Cell>
      </Table.Row>
      {open && (
        <Table.Row>
          {/* Table.Cell has no colSpan; a plain cell spans the row. */}
          <td colSpan={5} className="px-6">
            <div className="flex flex-col gap-y-2 py-2">
              <Text size="small" className="text-ui-fg-subtle">{t("review.notePrompt")}</Text>
              <Textarea
                value={note}
                maxLength={1000}
                onChange={(event) => setNote(event.target.value)}
                aria-label={t("review.notePrompt")}
              />
              <div className="flex justify-end gap-x-2">
                <Button size="small" variant="secondary" onClick={() => setOpen(false)}>
                  {t("review.cancel")}
                </Button>
                <Button
                  size="small"
                  onClick={() => review.mutate()}
                  isLoading={review.isPending}
                  disabled={!note.trim() || review.isPending}
                >
                  {t("review.save")}
                </Button>
              </div>
            </div>
          </td>
        </Table.Row>
      )}
    </>
  )
}

export const config = defineRouteConfig({
  label: "review.nav",
  translationNs: "liqpay",
})

export default LiqPayReviewPage
