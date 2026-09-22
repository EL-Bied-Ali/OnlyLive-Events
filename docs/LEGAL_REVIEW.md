# Legal review checklist — OnlyLive

Status: **draft only**. The public legal pages remain protected by `LEGAL_DOCUMENTS_APPROVED`.
Do not enable that flag until the lawyer/accountant review is complete and every blocking item below is resolved.

## 1. Confirmed company information

Source: certified Moroccan commercial-register extract supplied by the company.

- Legal name: **ONLYLIVE ENTERTAINMENT**
- Legal form: **SARL AU** (société à responsabilité limitée à associé unique)
- Registered office: **59 Avenue Ibn Sina, Appartement n°11, Agdal, Rabat, Morocco**
- Rabat commercial register: **RC 201789**
- ICE: **004012555000024**
- Share capital: **100,000 MAD**
- Manager: **Amine El Bied**
- Registered activity: **événementiel / entrepreneur de prestation de service**

Do not add CIN, date of birth, or other unnecessary personal identifiers to public legal pages.

## 2. Still missing / must be confirmed

### Corporate / tax

- [ ] Identifiant fiscal (IF)
- [ ] Taxe professionnelle reference, if counsel/accountant says it should be published
- [ ] Confirm whether online ticket sales are fully covered by the registered activity wording or require an update/additional activity
- [ ] Confirm that ONLYLIVE ENTERTAINMENT is the contracting seller on customer orders

### Public customer contact

- [ ] Public customer-service email
- [ ] Public customer-service / complaints phone number
- [ ] Privacy-rights contact email
- [ ] Confirm who is the publication director if that role should be identified separately from the manager

### ChariPay

- [ ] Confirm the production merchant/KYB account is legally held by ONLYLIVE ENTERTAINMENT
- [ ] Confirm the production payment-account RIB is in ONLYLIVE ENTERTAINMENT's name
- [ ] Confirm what happens to the original transaction commission when a payment is later refunded
- [ ] Obtain the required production credentials and refund scope separately; never commit them

ChariPay's public documentation states that refunds may be total or partial and that the refund operation itself is free:
https://charipay.ma/fr/faq
https://charipay.ma/fr/tarification

## 3. Consumer-law review

Official source: Moroccan Ministry of Justice, law n°31-08 on consumer protection:
https://adala.justice.gov.ma/api/uploads/2024/03/01/protection%20de%20consommateur-1709283839988.pdf

### CGV acceptance

Article 30 states that applicable contractual conditions must be easily accessible and expressly accepted by the consumer before confirmation of the offer.

Technical follow-up after legal approval:

- [ ] Add an explicit, non-prechecked CGV/refund-policy acceptance step before payment
- [ ] Store evidence of acceptance (order/user, timestamp, legal-document version)
- [ ] Keep a durable/versioned copy of the accepted legal text

### Fixed-date event tickets / withdrawal

Article 42 excludes articles 36 and 37 for leisure services supplied on a determined date or schedule. It also preserves articles 29 and 32 for electronically concluded contracts involving those services.

- [ ] Lawyer to confirm that the tickets sold by OnlyLive fall within this qualification
- [ ] Lawyer to approve the final wording for "change of mind" / withdrawal

### Cancellation / non-performance

Article 40 provides that when non-performance results from unavailability of the ordered service, the consumer must be informed and, where applicable, may be refunded without delay and no later than 15 days after payment.

- [ ] Lawyer to confirm application to event cancellation
- [ ] Business + lawyer to define the separate policy for event postponement
- [ ] Decide whether a postponed ticket remains valid automatically and whether the customer may instead request a refund

### Complaint information / durable information

Article 32 requires certain information to be provided in writing or another durable medium, including the address where complaints may be submitted.

- [ ] Confirm what the post-purchase email/receipt must contain
- [ ] Accountant/lawyer to determine the required invoice/receipt/ticket document for each paid order

## 4. CNDP / privacy review

Official CNDP guidance:
https://www.cndp.ma/conformite-des-sites-web/
https://www.cndp.ma/conditions/
https://www.cndp.ma/transfert-de-donnees-a-letranger/
https://www.cndp.ma/mentions-types/

The current application processes ordinary customer and technical data (name, email, phone, orders/tickets, session/security/payment/audit/scan data) and does not intentionally require CIN or sensitive categories.

Based on the current design and subject to CNDP/counsel confirmation:

- [ ] File the base CNDP notification before production
- [ ] If no CIN/sensitive/other authorization-triggering processing is added, prepare the prior-declaration path
- [ ] File the required foreign-transfer request(s) for providers/hosting outside Morocco
- [ ] Add the CNDP receipt/authorization references to the privacy notice once issued
- [ ] Add the prescribed collection notice at registration/checkout
- [ ] Use a non-prechecked consent/acknowledgement control where consent is the applicable basis
- [ ] Confirm recipients and all processors/subprocessors
- [ ] Confirm whether any marketing use is planned; do not silently reuse transactional data for marketing

### Production infrastructure information still needed

- [ ] Final database provider
- [ ] Final database region/country
- [ ] Final Vercel production data-location facts relevant to this processing
- [ ] Resend production sending setup and relevant processing locations
- [ ] Any additional analytics, monitoring, CRM, or marketing provider added before launch

### Retention schedule

Do not publish one blanket retention period. Define separate periods for:

- [ ] Customer account data
- [ ] Orders / accounting evidence
- [ ] Payment and refund records
- [ ] Tickets and access-control scans
- [ ] Authentication/session/security logs
- [ ] Audit logs
- [ ] Email delivery/outbox records

Have the accountant identify the legally required retention period for accounting/tax evidence and counsel validate the remainder.

## 5. Business-policy decisions still required

These cannot be recovered from registries or legislation because they are OnlyLive policy choices:

- [ ] Refund policy for a simple change of mind, subject to counsel's withdrawal analysis
- [ ] Policy if an event is postponed
- [ ] Any refund-processing or non-refundable fee passed to the customer
- [ ] Customer response-time target for refund/complaint requests
- [ ] Anti-resale / anti-fraud rules
- [ ] Maximum tickets per customer/event to state in the CGV
- [ ] Final liability / force-majeure wording
- [ ] Final dispute-resolution wording

## 6. Production gate

Do **not** set:

```
LEGAL_DOCUMENTS_APPROVED=true
```

until:

1. every public-facing `[À COMPLÉTER]` item is resolved,
2. the accountant has reviewed tax/accounting wording and retention,
3. counsel has approved the CGV, privacy, refund and legal-notice texts,
4. CNDP formalities relevant to the launch have been completed,
5. the checkout/registration changes required by the approved wording are implemented and tested.
